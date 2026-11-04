import { randomUUID } from "node:crypto";
import { win32 as path } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { environmentGatePassed, preflightApproved, readEnvironmentGate } from "./environment-gate.mjs";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

type Session = {
  id: string;
  title: string;
  projectPath: string;
  device?: { id: string; name: string };
  activeRun: null | { id: string; status: string };
  model?: string | null;
  permissionMode?: string;
  effort?: string | null;
  updatedAt?: string;
};
type Service = {
  readonly deviceId: string;
  sessions: Map<string, Session>;
  devices: unknown;
  request(command: Record<string, unknown>): Promise<any>;
  channel(timeoutMs?: number): Promise<unknown>;
  send(message: unknown): void;
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};
type Dependencies = {
  connectCCDesk?: (options?: Record<string, unknown>) => Promise<Service>;
  readEnvironmentGate?: () => Promise<any>;
};
type Tool = {
  id: string;
  name: string;
  input: string;
  target: string;
  stdout: string;
  stderr: string;
  status: string;
  exitCode: number | null;
  result?: string;
  progress?: number;
  taskId?: string;
};
type Turn = {
  id: string;
  clientMessageId: string;
  remoteMessageId?: string;
  runId?: string;
  started: boolean;
  checking: boolean;
  submitted: boolean;
  canceled: boolean;
};
type Approval = {
  toolId: string;
  runId: string;
  input: Record<string, unknown>;
  question: boolean;
  requested?: boolean;
  accepted?: boolean;
  observed?: boolean;
};
type OpenSession = {
  id: string;
  remote: Session;
  owned: boolean;
  sequence: number;
  ready: boolean;
  configuring?: boolean;
  blocked?: string;
  turn?: Turn;
  tools: Map<string, Tool>;
  approvals: Map<string, Approval>;
  streams: Map<string, { committed: string; fragment: string }>;
  messages: Map<string, string>;
  queued: any[];
  replayItems: Map<string, { item: any; timestamp?: string }>;
};

const CAPABILITIES = ["prompt.message", "session.list", "session.persistence", "session.configure", "permission"];
const MODES = [
  { id: "auto", label: "自动（原生）" },
  { id: "default", label: "标准审批" },
  { id: "plan", label: "计划" },
  { id: "acceptEdits", label: "接受编辑" },
] as const;
type SafeMode = (typeof MODES)[number]["id"];
const isSafeMode = (mode: unknown): mode is SafeMode =>
  typeof mode === "string" && MODES.some((item) => item.id === mode);
const samePath = (a: string, b: string) =>
  path.normalize(a).replace(/[\\/]+$/, "").toLowerCase() ===
  path.normalize(b).replace(/[\\/]+$/, "").toLowerCase();
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function validateConfig(config: any) {
  if (!nonempty(config?.cwd) || !path.isAbsolute(config.cwd))
    throw new Error("必须提供 Windows 项目的绝对路径。");
  if (config.persist !== true) throw new Error("CC Desk 会话必须保留原生上下文。");
  if (config.systemPrompt !== undefined)
    throw new Error("CC Desk 不支持由此 provider 注入系统提示或 MCP。");
  const env = config.env ?? {};
  const servers = config.mcpServers ?? {};
  const names = Object.keys(servers);
  let omitBuiltinMcp = false;
  if (names.length) {
    const server = servers.paseo;
    let valid = false;
    if (names.length === 1 && names[0] === "paseo" && server &&
        Object.keys(server).every((key) => ["type", "url", "headers"].includes(key)) &&
        ["http", "sse"].includes(server.type) && typeof server.url === "string" &&
        /^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/mcp\/agents(?:\?|$)/.test(server.url)) {
      try {
        const url = new URL(server.url);
        valid = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/mcp/agents" &&
          !url.username && !url.password && !url.hash && url.searchParams.size === 1 &&
          nonempty(env.PASEO_AGENT_ID) && url.searchParams.get("callerAgentId") === env.PASEO_AGENT_ID;
      } catch {}
    }
    if (!valid) throw new Error("CC Desk 不支持由此 provider 注入系统提示或 MCP。");
    omitBuiltinMcp = true;
  }
  if (Object.keys(env).some((key) => !["PASEO_AGENT_ID", "PASEO_AGENT_CWD"].includes(key)) ||
      (env.PASEO_AGENT_CWD !== undefined && (!nonempty(env.PASEO_AGENT_CWD) || !samePath(env.PASEO_AGENT_CWD, config.cwd))) ||
      (env.PASEO_AGENT_ID !== undefined && !nonempty(env.PASEO_AGENT_ID)) ||
      config.toolPolicy || Object.keys(config.settings ?? {}).length ||
      Object.keys(config.providerOptions ?? {}).length)
    throw new Error("CC Desk 不支持这些 provider 环境、工具策略或选项。");
  if (config.model !== undefined || config.thinkingOption !== undefined)
    throw new Error("此连接暂不支持从 Paseo 设置模型或思考强度。");
  if (config.mode !== undefined && !isSafeMode(config.mode))
    throw new Error("不支持此审批模式。");
  return omitBuiltinMcp;
}

function parseInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return { rawInput: input };
}

function summary(session: Session) {
  return {
    persistence: { version: 1, data: { sessionId: session.id, projectPath: session.projectPath, deviceId: session.device?.id ?? null } },
    cwd: session.projectPath,
    title: session.title,
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
  };
}

export function createCCDeskProvider(deps: Dependencies = {}): ProviderRegistration {
  // shortcut: ownership expires on plugin restart, persist when trusted provenance is available.
  const ownedSessions = new Map<string, { agentId: string; deviceId: string; projectPath: string }>();
  return {
    id: "ccdesk",
    label: "Claude · CC Desk VM",
    description: "通过原版 WSS 与 SSH 通道连接 CC Desk 服务器中的 Claude Code",
    async connect(providerRequest): Promise<ProviderConnection> {
      if (!providerRequest.versions.includes(1)) throw new Error("需要 Paseo provider 协议版本 1。");
      const capabilities = providerRequest.capabilities.filter((value) => CAPABILITIES.includes(value));
      const listeners = new Set<(event: ProviderEvent) => void>();
      let service: Service | undefined;
      let connecting: Promise<Service> | undefined;
      let current: OpenSession | undefined;
      let opening = false;
      let closed = false;

      const emit = (event: ProviderEvent) => {
        if (!closed) for (const listener of listeners) listener(event);
      };
      const notice = (state: OpenSession, title: string, severity: "info" | "warning" | "error" = "warning") =>
        emit({ type: "session.notice", sessionId: state.id, notice: { id: randomUUID(), severity, title } });
      const publishConfig = (state: OpenSession) => emit({
        type: "session.config", sessionId: state.id,
        config: {
          mode: state.remote.permissionMode,
          models: [], modes: state.owned ? [...MODES] : MODES.filter((mode) => mode.id === state.remote.permissionMode),
          thinkingOptions: [], settings: [],
        },
      });
      const block = (state: OpenSession, message: string) => {
        if (state.blocked) return;
        state.blocked = message;
        notice(state, message, "error");
      };
      const timeline = (state: OpenSession, item: any, timestamp?: string, replay = false) => {
        if (replay) {
          const old = state.replayItems.get(item.id);
          state.replayItems.set(item.id, { item, timestamp: old?.timestamp ?? timestamp });
        } else emit({ type: "timeline.item", sessionId: state.id, item, ...(timestamp ? { timestamp } : {}) });
      };
      const toolItem = (state: OpenSession, tool: Tool, timestamp?: string, replay = false) => {
        const status = tool.status === "completed" ? "completed" :
          tool.status === "cancelled" || tool.status === "denied" ? "canceled" :
          tool.status === "failed" || tool.status === "unknown" ? "failed" : "running";
        timeline(state, {
          type: "tool_call", id: `tool:${tool.id}`, callId: tool.id, name: tool.name,
          status, error: status === "failed" ? (tool.status === "unknown" ? "工具结果未知" : "工具执行失败") : null,
          detail: { type: "unknown", input: tool.input, output: tool.result ?? { stdout: tool.stdout, stderr: tool.stderr } },
          metadata: {
            target: tool.target, ccdeskStatus: tool.status, exitCode: tool.exitCode,
            ...(tool.progress === undefined ? {} : { elapsedSeconds: tool.progress }),
            ...(tool.taskId === undefined ? {} : { taskId: tool.taskId }),
          },
        }, timestamp, replay);
      };
      const appendStream = (state: OpenSession, key: string, text: string, fragment: boolean) => {
        const value = state.streams.get(key) ?? { committed: "", fragment: "" };
        if (fragment) value.fragment += text;
        else {
          value.committed += text;
          value.fragment = "";
        }
        state.streams.set(key, value);
        return value.committed + value.fragment;
      };
      const finishApproval = (state: OpenSession, id: string, approval: Approval) => {
        if (approval.observed === undefined || !approval.accepted) return;
        if (approval.observed !== approval.requested) {
          block(state, "审批结果与本窗口提交不一致，请在 CC Desk 核对。");
          return;
        }
        state.approvals.delete(id);
        emit({ type: "session.permission_resolved", sessionId: state.id, permissionId: id });
      };
      const apply = (state: OpenSession, message: any, replay = false) => {
        const event = message.type === "session.event" ? message.event : message;
        const payload = event?.payload;
        if (!payload || (event.sessionId ?? message.sessionId) !== state.remote.id) return;
        const fragment = message.type === "session.fragment";
        if (!fragment) {
          if (!Number.isInteger(event.sequence) || event.sequence <= state.sequence) return;
          state.sequence = event.sequence;
        }
        const timestamp = nonempty(event.createdAt) ? event.createdAt : undefined;
        const turn = state.turn;
        const runId = event.runId ?? message.runId;

        if (payload.type === "message.user") {
          const clientMessageId = state.messages.get(payload.messageId);
          if (!replay && turn && payload.messageId !== turn.remoteMessageId && !clientMessageId)
            block(state, "检测到其他窗口向运行中的会话发送消息，不能安全同步。");
          timeline(state, {
            type: "user_message", id: `user:${payload.messageId}`, messageId: payload.messageId,
            text: payload.text, ...(clientMessageId ? { clientMessageId } : {}),
          }, timestamp, replay);
        } else if (payload.type === "text.delta" || payload.type === "thinking.delta") {
          const kind = payload.type === "text.delta" ? "assistant_message" : "reasoning";
          const key = `${payload.type}:${payload.messageId}`;
          timeline(state, { type: kind, id: key, text: appendStream(state, key, payload.text, fragment) }, timestamp, replay);
        } else if (payload.type === "tool.requested") {
          const tool: Tool = {
            id: payload.toolId, name: payload.name, input: payload.input, target: payload.target,
            stdout: "", stderr: "", status: "running", exitCode: null,
          };
          state.tools.set(tool.id, tool);
          toolItem(state, tool, timestamp, replay);
        } else if (["tool.input", "tool.input.delta", "tool.output", "tool.progress", "tool.task", "tool.result"].includes(payload.type)) {
          const tool = state.tools.get(payload.toolId);
          if (!tool) {
            if (!replay) block(state, "缺少工具请求，无法安全还原工具事件。");
            return;
          }
          if (payload.type === "tool.input") {
            tool.input = payload.input;
            state.streams.delete(`input:${tool.id}`);
          } else if (payload.type === "tool.input.delta") {
            const key = `input:${tool.id}`;
            if (!state.streams.has(key)) state.streams.set(key, { committed: tool.input === "{}" ? "" : tool.input, fragment: "" });
            tool.input = appendStream(state, key, payload.text, fragment);
          } else if (payload.type === "tool.output" && (payload.stream === "stdout" || payload.stream === "stderr")) {
            const stream: "stdout" | "stderr" = payload.stream;
            tool[stream] = appendStream(state, `output:${tool.id}:${stream}`, payload.text, fragment);
          } else if (payload.type === "tool.progress") tool.progress = payload.elapsedSeconds;
          else if (payload.type === "tool.task") tool.taskId = payload.taskId;
          else if (payload.type === "tool.result") {
            tool.status = payload.status;
            tool.result = payload.output;
            tool.exitCode = payload.exitCode;
          }
          toolItem(state, tool, timestamp, replay);
        } else if (payload.type === "message.delivery" && !replay) {
          const labels: Record<string, string> = {
            submitted: "消息已提交，等待原生确认。", queued: "消息等待原生处理。",
            received: "消息已由原生进程接收。", not_sent: "消息未送达原生进程。",
            unconfirmed: "消息是否送达原生进程尚未确认，请勿自动重发。",
          };
          if (labels[payload.status]) notice(state, labels[payload.status], payload.status === "received" ? "info" : "warning");
        } else if (payload.type === "approval.requested" && !replay) {
          const tool = state.tools.get(payload.toolId);
          if (!turn || !nonempty(runId) || !tool || !nonempty(payload.approvalId)) {
            block(state, "审批缺少运行或工具信息，不能安全处理。");
            return;
          }
          const input = parseInput(tool.input);
          state.approvals.set(payload.approvalId, { toolId: tool.id, runId, input, question: tool.name === "AskUserQuestion" });
          emit({
            type: "session.permission", sessionId: state.id,
            request: {
              id: payload.approvalId, name: tool.name, kind: tool.name === "AskUserQuestion" ? "question" : "tool",
              input, actions: [
                { id: "allow-once", label: "允许一次", behavior: "allow" },
                { id: "deny", label: "拒绝", behavior: "deny" },
              ],
            },
          } as ProviderEvent);
        } else if (payload.type === "approval.resolved" && !replay) {
          const approval = state.approvals.get(payload.approvalId);
          if (!approval || approval.requested === undefined) {
            block(state, "审批已由其他窗口处理，此连接不能安全同步其结果。");
            return;
          }
          approval.observed = payload.allowed;
          finishApproval(state, payload.approvalId, approval);
        } else if (payload.type === "run.status" && !replay) {
          if (!turn) {
            if (payload.status === "running" || payload.status === "awaiting_approval")
              block(state, "会话已在其他窗口运行，此连接不能安全接入。");
            return;
          }
          if (!nonempty(runId) || (turn.runId && turn.runId !== runId)) {
            block(state, "运行标识不一致，不能安全同步。");
            return;
          }
          turn.runId = runId;
          if (!turn.started) {
            turn.started = true;
            emit({ type: "session.turn", sessionId: state.id, turnId: turn.id, state: "started" });
          }
          if (["completed", "failed", "cancelled"].includes(payload.status)) {
            emit({
              type: "session.turn", sessionId: state.id, turnId: turn.id,
              state: payload.status === "cancelled" ? "canceled" : payload.status,
              ...(payload.status === "failed" ? { error: { message: payload.reason ?? "CC Desk 运行失败" } } : {}),
            } as ProviderEvent);
            state.turn = undefined;
            if (state.approvals.size) block(state, "运行结束时仍有未确认的审批，请在 CC Desk 核对。");
          }
        } else if (payload.type === "run.error" && !replay) {
          notice(state, payload.message || "CC Desk 运行错误。", "error");
        }
      };
      const onMessage = (message: any) => {
        if (message?.type === "session.deleted" && nonempty(message.sessionId))
          ownedSessions.delete(message.sessionId);
        const state = current;
        if (!state) return;
        if (message?.type === "session.deleted" && message.sessionId === state.remote.id)
          block(state, "CC Desk 会话已删除，不能继续发送。");
        if (message?.type === "session.updated" && message.session?.id === state.remote.id) {
          if (!nonempty(message.session.projectPath) || !samePath(message.session.projectPath, state.remote.projectPath) ||
              message.session.device?.id !== state.remote.device?.id)
            block(state, "会话的设备或项目绑定已改变，不能继续发送。");
          else if (!isSafeMode(message.session.permissionMode))
            block(state, "会话审批模式未知或不受支持，不能继续发送。");
          else if (message.session.activeRun && (!state.turn || (state.turn.checking && !state.turn.submitted)))
            block(state, "会话已在其他窗口运行，此连接不能安全接入。");
          else if (message.session.permissionMode !== state.remote.permissionMode) {
            state.remote.permissionMode = message.session.permissionMode;
            if (state.ready && !state.configuring) publishConfig(state);
          }
        }
        if (message?.type !== "session.event" && message?.type !== "session.fragment") return;
        if ((message.event?.sessionId ?? message.sessionId) !== state.remote.id) return;
        if (!state.ready || state.turn?.checking) state.queued.push(message);
        else {
          try { apply(state, message); }
          catch { block(state, "CC Desk 事件无法安全解析。"); }
        }
      };
      const onEnd = () => {
        if (current) block(current, "CC Desk 连接中断；在途请求的结果可能未知，不会自动重发。");
      };
      const getService = async () => {
        if (!connecting) connecting = (async () => {
          try {
            const report = await (deps.readEnvironmentGate ?? readEnvironmentGate)();
            if (!preflightApproved(report)) throw new Error("CC Desk 前置检查未明确允许，禁止建立连接。");
          } catch (error) {
            connecting = undefined;
            throw error;
          }
          const connect = deps.connectCCDesk ?? (await import("./ccdesk-service.mjs")).connectCCDesk;
          const connected: Service = await connect();
          if (!nonempty(connected.deviceId) || !(connected.sessions instanceof Map) || typeof connected.request !== "function" ||
              typeof connected.channel !== "function" || typeof connected.close !== "function")
            throw new Error("CC Desk Service 接口不完整。");
          connected.on("message", onMessage);
          connected.on("end", onEnd);
          service = connected;
          return connected;
        })();
        return connecting;
      };
      const request = async (connection: Service, command: Record<string, unknown>) => {
        const result = await connection.request(command);
        if (!result || (result.type === "response" && result.ok !== true))
          throw new Error(result?.message || "CC Desk 请求失败。");
        return result;
      };
      const requireIdle = (connection: Service) => {
        if ([...connection.sessions.values()].some((session) => session.device?.id === connection.deviceId && session.activeRun))
          throw new Error("本设备存在正在运行的 CC Desk 会话，暂时不能接入以免影响现有工作。");
      };
      const getCurrent = (id: string) => {
        if (!current || current.id !== id) throw new Error("未知的 Paseo 会话。");
        return current;
      };
      async function configureMode(state: OpenSession, mode: SafeMode) {
        if (!capabilities.includes("session.configure")) throw new Error("未协商审批模式设置能力。");
        if (!state.owned) throw new Error("不会修改已有 CC Desk 会话的设置。");
        if (state.blocked) throw new Error(state.blocked);
        if (state.turn || state.configuring) throw new Error("会话未空闲，不能修改审批模式。");
        state.configuring = true;
        try {
          const connection = await getService();
          if (state.blocked) throw new Error(state.blocked);
          const before = connection.sessions.get(state.remote.id);
          if (!before || before.activeRun || !isSafeMode(before.permissionMode) ||
              !samePath(before.projectPath, state.remote.projectPath) || before.device?.id !== state.remote.device?.id)
            throw new Error("会话状态或项目绑定已改变，不能修改审批模式。");
          if (before.permissionMode !== mode) {
            try {
              const result = await request(connection, {
                type: "session.configure", sessionId: state.remote.id, permissionMode: mode,
              });
              if (result.type !== "response") throw new Error("配置响应无效。");
              if (state.blocked) throw new Error(state.blocked);
              const after = connection.sessions.get(state.remote.id);
              if (!after || after.activeRun || after.permissionMode !== mode ||
                  !samePath(after.projectPath, state.remote.projectPath) || after.device?.id !== state.remote.device?.id)
                throw new Error("无法确认审批模式。");
            } catch {
              block(state, "审批模式变更未确认，请在 CC Desk 核对；不会自动重试。");
              throw new Error("审批模式变更未确认，请在 CC Desk 核对；不会自动重试。");
            }
          }
          state.remote.permissionMode = mode;
        } finally {
          state.configuring = false;
        }
      }

      async function open(input: Extract<ProviderInput, { type: "session.open" }>) {
        const omitBuiltinMcp = validateConfig(input.config);
        if (opening || current) throw new Error("此连接一次只支持一个打开的 CC Desk 会话。");
        opening = true;
        try {
          const connection = await getService();
          requireIdle(connection);
          let remote: Session | undefined;
          let createdHere = false;
          if (input.persistence) {
            if (!capabilities.includes("session.persistence")) throw new Error("未协商会话恢复能力。");
            const data = input.persistence.data as any;
            if (input.persistence.version !== 1 || !nonempty(data?.sessionId) || !nonempty(data?.projectPath))
              throw new Error("无效的 CC Desk 会话句柄。");
            remote = connection.sessions.get(data.sessionId);
            if (!remote || !remote.device?.id || remote.device.id !== data.deviceId ||
                !samePath(remote.projectPath, data.projectPath) || !samePath(remote.projectPath, input.config.cwd))
              throw new Error("会话、设备或项目绑定发生变化；不会自动迁移。");
          } else {
            const existingIds = new Set(connection.sessions.keys());
            const created = await request(connection, {
              type: "session.create", title: input.config.title?.trim() || "Paseo 会话", projectPath: input.config.cwd,
            });
            if (created.type !== "response" || !nonempty(created.sessionId))
              throw new Error("无法确认 CC Desk 新会话；不会自动重试。");
            if (existingIds.has(created.sessionId))
              throw new Error("服务端返回了已有会话；不会修改其设置。");
            remote = connection.sessions.get(created.sessionId);
            if (!remote || !remote.device?.id || remote.device.id !== connection.deviceId ||
                !samePath(remote.projectPath, input.config.cwd))
              throw new Error("无法确认新会话的设备和项目绑定。");
            createdHere = true;
          }
          if (remote.activeRun) throw new Error("不支持导入正在运行的会话。");
          if (!isSafeMode(remote.permissionMode))
            throw new Error("会话审批模式未知或不受支持，未修改会话。");
          if (input.persistence && input.config.mode !== undefined && input.config.mode !== remote.permissionMode)
            throw new Error("已有会话审批模式与请求不一致，请先手动设置。");
          remote = { ...remote, device: remote.device ? { ...remote.device } : undefined };
          const agentId = input.config.env?.PASEO_AGENT_ID;
          const owner = ownedSessions.get(remote.id);
          const state: OpenSession = {
            id: input.sessionId, remote,
            owned: createdHere || Boolean(owner && nonempty(agentId) && owner.agentId === agentId &&
              owner.deviceId === remote.device?.id && owner.deviceId === connection.deviceId &&
              samePath(owner.projectPath, remote.projectPath)),
            sequence: 0, ready: false, tools: new Map(), approvals: new Map(),
            streams: new Map(), messages: new Map(), queued: [], replayItems: new Map(),
          };
          current = state;
          const first = await request(connection, { type: "session.subscribe", sessionId: remote.id, afterSequence: 0 });
          if (first.type !== "session.snapshot" || first.session?.id !== remote.id || first.session.activeRun)
            throw new Error("无法安全订阅空闲会话。");
          const pages = [first];
          let page = first;
          if (input.history === "replay") {
            while (page.hasEarlier) {
              if (!Number.isInteger(page.firstSequence) || page.firstSequence <= 0)
                throw new Error("CC Desk 历史游标无效。");
              const previous = await request(connection, { type: "session.history", sessionId: remote.id, beforeSequence: page.firstSequence });
              if (previous.type !== "session.snapshot" || previous.session?.id !== remote.id ||
                  previous.firstSequence >= page.firstSequence)
                throw new Error("CC Desk 历史分页未前进。");
              pages.unshift(previous);
              page = previous;
            }
          }
          requireIdle(connection);
          if (state.blocked) throw new Error(state.blocked);
          const latest = connection.sessions.get(remote.id);
          if (!latest || latest.activeRun || !samePath(latest.projectPath, remote.projectPath) || latest.device?.id !== remote.device?.id)
            throw new Error("会话状态或项目绑定已改变。");
          if (!isSafeMode(latest.permissionMode))
            throw new Error("会话审批模式未知或不受支持，未修改会话。");
          state.remote.permissionMode = latest.permissionMode;
          const requestedMode = input.config.mode;
          if (input.persistence && requestedMode !== undefined && requestedMode !== latest.permissionMode)
            throw new Error("已有会话审批模式与请求不一致，请先手动设置。");
          if (createdHere && requestedMode === "auto" && latest.permissionMode !== "auto")
            throw new Error("服务端默认审批模式与 Paseo 默认不一致，请先手动核对。");
          if (createdHere && requestedMode !== undefined && requestedMode !== latest.permissionMode) {
            if (!isSafeMode(requestedMode)) throw new Error("不支持此审批模式。");
            await configureMode(state, requestedMode);
          }
          emit({
            type: "session.opened", requestId: input.requestId, sessionId: state.id,
            capabilities: state.owned ? capabilities : capabilities.filter((capability) => capability !== "session.configure"),
            restoration: "core", persistence: summary(remote).persistence, cwd: remote.projectPath, title: remote.title,
          } as ProviderEvent);
          publishConfig(state);
          if (input.history === "replay") {
            for (const item of pages.flatMap((value) => value.events)) apply(state, { type: "session.event", event: item }, true);
            for (const entry of state.replayItems.values()) timeline(state, entry.item, entry.timestamp);
          } else state.sequence = first.lastSequence;
          if (omitBuiltinMcp)
            notice(state, "此 CC Desk 会话未接入 Paseo 内建 MCP，服务端自身 MCP 配置不变", "warning");
          state.ready = true;
          for (const event of state.queued.splice(0)) apply(state, event);
          emit({ type: "session.ready", requestId: input.requestId, sessionId: state.id });
          if (createdHere && nonempty(agentId) && remote.device)
            ownedSessions.set(remote.id, { agentId, deviceId: remote.device.id, projectPath: remote.projectPath });
        } catch (error) {
          current = undefined;
          throw error;
        } finally { opening = false; }
      }

      async function prompt(input: Extract<ProviderInput, { type: "session.prompt" }>) {
        const state = getCurrent(input.sessionId);
        if (!capabilities.includes("prompt.message")) throw new Error("未协商文字消息能力。");
        if (state.blocked) throw new Error(state.blocked);
        if (!state.ready || state.configuring) throw new Error("会话尚未就绪，不能发送消息。");
        if (state.turn) throw new Error("运行中不能追加消息；请等本轮结束。");
        if (input.prompt.delivery !== "auto" || input.prompt.outputSchema !== undefined || input.prompt.clearPendingPermissions)
          throw new Error("不支持中途追加、输出 schema 或清除审批。");
        if (input.prompt.input.type !== "message" || input.prompt.input.content.some((part) => part.type !== "text"))
          throw new Error("只支持文字消息，不支持附件或命令。");
        const text = input.prompt.input.content.map((part: any) => part.text).join("\n").trim();
        if (!text || text.length > 16000) throw new Error("消息为空或超过 CC Desk 的长度限制。");
        const turn: Turn = { id: randomUUID(), clientMessageId: input.prompt.clientMessageId, started: false, checking: true, submitted: false, canceled: false };
        state.turn = turn;
        let submitted = false;
        try {
          const connection = await getService();
          const report = await (deps.readEnvironmentGate ?? readEnvironmentGate)();
          if (!environmentGatePassed(report, true))
            throw new Error("CC Desk 环境前置检查未明确允许发送。");
          if (turn.canceled) throw new Error("发送已取消。");
          const channel = await connection.channel();
          if (channel !== undefined && channel !== true) throw new Error("CC Desk 设备 SSH 通道未就绪。");
          if (turn.canceled) throw new Error("发送已取消。");
          if (state.blocked) throw new Error(state.blocked);
          requireIdle(connection);
          const latest = connection.sessions.get(state.remote.id);
          if (!latest || !samePath(latest.projectPath, state.remote.projectPath) || latest.device?.id !== state.remote.device?.id) {
            block(state, "会话的设备或项目绑定已改变，不能继续发送。");
            throw new Error(state.blocked);
          }
          submitted = true;
          turn.submitted = true;
          const response = await request(connection, { type: "message.send", sessionId: state.remote.id, text });
          if (response.type !== "response" || !nonempty(response.requestId))
            throw new Error("消息响应缺少请求标识。");
          turn.remoteMessageId = response.requestId;
          state.messages.set(response.requestId, turn.clientMessageId);
          emit({ type: "session.prompt_result", sessionId: state.id, clientMessageId: turn.clientMessageId, result: { type: "turn", turnId: turn.id } });
          turn.checking = false;
          for (const event of state.queued.splice(0)) apply(state, event);
        } catch (error) {
          if (submitted) block(state, "消息提交结果未知；请核对 CC Desk 历史，不能自动重发。");
          if (state.turn === turn) state.turn = undefined;
          state.queued.length = 0;
          throw error;
        }
      }

      async function permission(input: Extract<ProviderInput, { type: "session.permission" }>) {
        const state = getCurrent(input.sessionId);
        if (state.blocked) throw new Error(state.blocked);
        const approval = state.approvals.get(input.permissionId);
        const response = input.response;
        if (!approval || approval.requested !== undefined) throw new Error("审批不存在或已经提交。");
        if (response.behavior !== "allow" && response.behavior !== "deny") throw new Error("无效的审批决定。");
        if ((response.behavior === "allow" && response.selectedActionId && response.selectedActionId !== "allow-once") ||
            (response.behavior === "deny" && response.selectedActionId && response.selectedActionId !== "deny"))
          throw new Error("仅支持允许一次或拒绝。");
        let answers: Record<string, string> | undefined;
        if (response.behavior === "allow") {
          if (response.updatedPermissions !== undefined &&
              (!Array.isArray(response.updatedPermissions) || response.updatedPermissions.length > 0))
            throw new Error("不能增加永久权限。");
          if (approval.question) {
            const updated = response.updatedInput;
            if (!updated || !updated.answers || typeof updated.answers !== "object" || Array.isArray(updated.answers) ||
                Object.keys(updated.answers).length === 0)
              throw new Error("提问必须提供明确答案。");
            const { answers: value, ...original } = updated;
            if (!isDeepStrictEqual(original, approval.input) ||
                Object.entries(value as object).some(([key, answer]) => key.length > 2000 || typeof answer !== "string" || answer.length > 4000))
              throw new Error("不支持修改问题或提交无效答案。");
            answers = value as Record<string, string>;
          } else if (response.updatedInput !== undefined && !isDeepStrictEqual(response.updatedInput, approval.input))
            throw new Error("不支持修改工具输入。");
        } else if (response.interrupt || response.message) throw new Error("不支持额外的拒绝消息或中断选项。");
        approval.requested = response.behavior === "allow";
        try {
          const connection = await getService();
          const result = await request(connection, {
            type: "approval.reply", sessionId: state.remote.id, runId: approval.runId,
            approvalId: input.permissionId, allowed: approval.requested, ...(answers ? { answers } : {}),
          });
          if (result.type !== "response") throw new Error("审批响应无效。");
          approval.accepted = true;
          finishApproval(state, input.permissionId, approval);
        } catch (error) {
          block(state, "审批结果未知或已由其他窗口处理，请在 CC Desk 核对。");
          throw error;
        }
      }

      return {
        version: 1,
        capabilities,
        async send(input) {
          if (closed) throw new Error("Provider 连接已关闭。");
          if (input.type === "catalog") {
            emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [...MODES], defaultMode: "auto", thinkingOptions: [] } });
          } else if (input.type === "sessions") {
            if (!capabilities.includes("session.list")) throw new Error("未协商会话列表能力。");
            const connection = await getService();
            let sessions = [...connection.sessions.values()].filter((session) =>
              (!input.cwd || samePath(session.projectPath, input.cwd)) &&
              (!input.query || (session.title + " " + session.projectPath).toLowerCase().includes(input.query.toLowerCase())));
            if (input.limit) sessions = sessions.slice(0, input.limit);
            emit({ type: "sessions", requestId: input.requestId, sessions: sessions.map(summary) });
          } else if (input.type === "session.open") await open(input);
          else if (input.type === "session.prompt") await prompt(input);
          else if (input.type === "session.configure") {
            const state = getCurrent(input.sessionId);
            if (!state.ready) throw new Error("会话尚未就绪，不能修改审批模式。");
            if (Object.keys(input.changes).some((key) => key !== "mode") || !isSafeMode(input.changes.mode))
              throw new Error("只支持设置安全审批模式，不支持模型或思考强度变更。");
            await configureMode(state, input.changes.mode);
            publishConfig(state);
            emit({ type: "request.completed", requestId: input.requestId });
          }
          else if (input.type === "session.permission") {
            if (!capabilities.includes("permission")) throw new Error("未协商审批能力。");
            await permission(input);
          } else if (input.type === "session.interrupt") {
            const state = getCurrent(input.sessionId);
            if (!state.turn) throw new Error("没有可取消的运行。");
            if (state.turn.checking && !state.turn.submitted) state.turn.canceled = true;
            else {
              if (!state.turn.runId) throw new Error("运行标识尚未确认，不能安全取消。");
              const result = await request(await getService(), { type: "run.cancel", sessionId: state.remote.id, runId: state.turn.runId });
              if (result.type !== "response") throw new Error("取消响应无效。");
            }
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.close") {
            const state = getCurrent(input.sessionId);
            if (state.turn || state.configuring) throw new Error("运行或模式设置尚未结束。");
            current = undefined;
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
          } else throw new Error(`不支持的 provider 操作：${input.type}`);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          if (opening) throw new Error("会话正在打开，不能关闭设备连接。");
          if (current?.turn || current?.configuring) throw new Error("运行尚未结束，不能关闭设备连接。");
          if (closed) return;
          if (connecting) await connecting.catch(() => undefined);
          if (service) requireIdle(service);
          closed = true;
          if (service) {
            service.off("message", onMessage);
            service.off("end", onEnd);
            await service.close();
          }
          listeners.clear();
        },
      };
    },
  };
}
