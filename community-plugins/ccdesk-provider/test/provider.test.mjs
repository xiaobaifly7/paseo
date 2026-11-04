import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { ProviderInputSchema, ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { readEnvironmentGate } from "../server/environment-gate.mjs";
import { createCCDeskProvider } from "../server/provider.ts";

const sdkInputs = [];
const sdkEvents = [];
const malformedMcpFixtures = new WeakSet();
function observe(connection, events) {
  const send = connection.send.bind(connection);
  connection.send = async (input) => {
    sdkInputs.push({
      value: structuredClone(input),
      expectInvalid: input.type === "session.open" && malformedMcpFixtures.has(input.config.mcpServers),
    });
    return send(input);
  };
  connection.onEvent((event) => {
    events.push(event);
    sdkEvents.push(structuredClone(event));
  });
}

after(() => {
  const inputTypes = new Set(sdkInputs.map((item) => item.value.type));
  const eventTypes = new Set(sdkEvents.map((item) => item.type));
  for (const type of ["catalog", "sessions", "session.open", "session.configure", "session.prompt", "session.permission", "session.interrupt", "session.close"])
    assert.ok(inputTypes.has(type), `missing SDK input fixture: ${type}`);
  for (const type of ["catalog", "sessions", "session.opened", "session.config", "session.ready", "session.prompt_result",
    "session.turn", "timeline.item", "session.permission", "session.permission_resolved", "session.notice", "session.closed", "request.completed"])
    assert.ok(eventTypes.has(type), `missing SDK event fixture: ${type}`);
  const errors = [];
  for (const [kind, schema, items] of [["input", ProviderInputSchema, sdkInputs], ["event", ProviderEventSchema, sdkEvents]]) {
    for (const [index, entry] of items.entries()) {
      const item = kind === "input" ? entry.value : entry;
      const expectedInvalid = kind === "input" && entry.expectInvalid;
      const result = schema.safeParse(item);
      if (expectedInvalid && result.success) errors.push({ kind, index, type: item?.type, issues: ["expected_invalid"] });
      if (!expectedInvalid && !result.success) errors.push({ kind, index, type: item?.type,
        issues: result.error.issues.map(({ code }) => code) });
    }
  }
  assert.deepEqual(errors, [], "Paseo SDK schema validation failed");

});

const sessionId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const approvalId = "44444444-4444-4444-8444-444444444444";
const project = "C:\\project";
const config = { cwd: project, env: {}, mcpServers: {}, settings: {}, persist: true };
const persistence = { version: 1, data: { sessionId, projectPath: project, deviceId } };
const passingGate = () => ({ allow: true });

class FakeService extends EventEmitter {
  constructor() {
    super();
    this.deviceId = deviceId;
    this.sessions = new Map([[sessionId, {
      id: sessionId, title: "Existing", projectPath: project,
      device: { id: deviceId, name: "Windows" }, permissionMode: "auto",
      model: "existing-model", effort: "high", activeRun: null,
    }]]);
    this.devices = [{ id: deviceId, ready: true }];
    this.calls = [];
    this.trace = [];
    this.sequence = 2;
    this.messages = 0;
    this.ready = true;
  }
  async channel() {
    this.trace.push("channel");
    if (!this.ready) throw new Error("channel not ready");
    return this.channelResult;
  }
  async request(command) {
    this.calls.push(command);
    this.trace.push(command.type);
    let session = this.sessions.get(command.sessionId ?? sessionId);
    if (command.type === "session.create") {
      session = { id: sessionId, title: command.title, projectPath: command.projectPath,
        device: { id: deviceId, name: "Windows" }, permissionMode: this.createdMode ?? "auto", model: null, effort: null, activeRun: null };
      this.sessions.set(sessionId, session);
      this.sequence = 0;
      this.emptyHistory = true;
      return { type: "response", ok: true, requestId: "create-request", sessionId };
    }
    if (command.type === "session.configure") {
      if (this.failConfigure) throw new Error("configuration connection lost");
      if (this.configureBarrier) await this.configureBarrier;
      if (session.activeRun) throw new Error("session running");
      session.permissionMode = command.permissionMode;
      if ("model" in command) session.model = command.model;
      if ("effort" in command) session.effort = command.effort;
      this.emit("message", { type: "session.updated", session });
      return { type: "response", ok: true, requestId: "configure-request", sessionId };
    }
    if (command.type === "session.subscribe" && this.emptyHistory) return {
      type: "session.snapshot", session, events: [], firstSequence: 0, lastSequence: 0, hasEarlier: false,
    };
    if (command.type === "session.subscribe") return {
      type: "session.snapshot", session, events: [{
        sessionId, runId, sequence: 2, createdAt: "2026-01-01T00:00:01.000Z",
        payload: { type: "text.delta", messageId: "old-assistant", text: "old reply" },
      }], firstSequence: 2, lastSequence: 2, hasEarlier: true,
    };
    if (command.type === "session.history") return {
      type: "session.snapshot", session, events: [{
        sessionId, runId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z",
        payload: { type: "message.user", messageId: "old-user", text: "old question" },
      }], firstSequence: 1, lastSequence: 1, hasEarlier: false,
    };
    if (command.type === "message.send") {
      if (this.failSend) throw new Error("connection lost");
      const requestId = `55555555-5555-4555-8555-${String(++this.messages).padStart(12, "0")}`;
      session.activeRun = { id: runId, status: "running" };
      this.event({ type: "message.user", messageId: requestId, text: command.text });
      this.event({ type: "run.status", status: "running", connectionId: deviceId });
      this.emit("message", { type: "session.updated", session });
      return { type: "response", ok: true, requestId, sessionId };
    }
    if (command.type === "approval.reply") {
      this.event({ type: "approval.resolved", approvalId: command.approvalId, allowed: command.allowed });
      return { type: "response", ok: true, requestId: "approval-request", sessionId };
    }
    if (command.type === "run.cancel") {
      session.activeRun = null;
      this.event({ type: "run.status", status: "cancelled", connectionId: deviceId });
      return { type: "response", ok: true, requestId: "cancel-request", sessionId };
    }
    throw new Error(`unexpected request: ${command.type}`);
  }
  event(payload) {
    this.emit("message", { type: "session.event", event: {
      sessionId, runId, sequence: ++this.sequence, createdAt: "2026-01-01T00:00:02.000Z", payload,
    } });
  }
  fragment(payload) {
    this.emit("message", { type: "session.fragment", sessionId, runId, payload });
  }
  send() { throw new Error("raw send must not be used"); }
  async close() { this.closed = true; }
}

async function setup(service, gate = async () => passingGate()) {
  const provider = createCCDeskProvider({ connectCCDesk: async () => service, readEnvironmentGate: gate });
  const connection = await provider.connect({
    versions: [1], capabilities: ["prompt.message", "session.list", "session.persistence", "session.configure", "permission"],
  });
  const events = [];
  observe(connection, events);
  return { connection, events };
}

const open = (connection, extra = {}) => connection.send({
  type: "session.open", requestId: "open", sessionId: "paseo-session",
  config, persistence, history: "replay", ...extra,
});
const prompt = (connection, clientMessageId = "message-1", content = [{ type: "text", text: "hello" }]) =>
  connection.send({ type: "session.prompt", sessionId: "paseo-session", prompt: {
    clientMessageId, delivery: "auto", input: { type: "message", content },
  } });

test("requires preflight before opening the transport and permits an explicit retry", async () => {
  const service = new FakeService();
  let report = { allow: false };
  let connects = 0;
  const provider = createCCDeskProvider({
    readEnvironmentGate: async () => report,
    connectCCDesk: async () => { connects++; return service; },
  });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list"] });
  observe(connection, []);
  await assert.rejects(connection.send({ type: "sessions", requestId: "denied-list" }), /前置检查未明确允许/);
  assert.equal(connects, 0);
  report = passingGate();
  await connection.send({ type: "sessions", requestId: "allowed-list" });
  assert.equal(connects, 1);
  await connection.close();
});

test("replays history, gates each turn, maps tool and approval events, cancels and continues", async () => {
  const service = new FakeService();
  let gateCount = 0;
  const { connection, events } = await setup(service, async () => {
    gateCount++;
    service.trace.push("gate");
    return passingGate();
  });
  await connection.send({ type: "catalog", requestId: "catalog" });
  const catalog = events.find((event) => event.type === "catalog").catalog;
  assert.deepEqual(catalog.modes.map((mode) => mode.id), ["auto", "default", "plan", "acceptEdits"]);
  assert.equal(catalog.defaultMode, "auto");
  await connection.send({ type: "sessions", requestId: "list" });
  assert.equal(events.find((event) => event.type === "sessions").sessions[0].persistence.data.sessionId, sessionId);
  await open(connection);
  assert.deepEqual(events.filter((event) => event.type === "timeline.item").map((event) => event.item.text), ["old question", "old reply"]);

  await prompt(connection);
  assert.deepEqual(service.trace.slice(-3), ["gate", "channel", "message.send"]);
  assert.equal(events.find((event) => event.type === "timeline.item" && event.item.clientMessageId === "message-1").item.text, "hello");
  service.fragment({ type: "text.delta", messageId: "answer", text: "你" });
  service.fragment({ type: "text.delta", messageId: "answer", text: "好" });
  service.event({ type: "text.delta", messageId: "answer", text: "你好" });
  assert.equal(events.filter((event) => event.type === "timeline.item" && event.item.id === "text.delta:answer").at(-1).item.text, "你好");

  service.event({ type: "tool.requested", toolId: "tool-1", name: "Bash", input: '{"command":"pwd"}', target: "Windows" });
  service.fragment({ type: "tool.output", toolId: "tool-1", stream: "stdout", text: "ok" });
  service.event({ type: "tool.output", toolId: "tool-1", stream: "stdout", text: "ok" });
  service.event({ type: "approval.requested", approvalId, toolId: "tool-1" });
  const approval = events.find((event) => event.type === "session.permission");
  assert.deepEqual(approval.request.actions.map((action) => action.id), ["allow-once", "deny"]);
  await assert.rejects(connection.send({
    type: "session.permission", sessionId: "paseo-session", permissionId: approvalId,
    response: { behavior: "allow", updatedPermissions: [{ arbitrary: true }] },
  }), /永久权限/);
  await connection.send({
    type: "session.permission", sessionId: "paseo-session", permissionId: approvalId,
    response: { behavior: "allow", selectedActionId: "allow-once" },
  });
  assert.equal(events.filter((event) => event.type === "session.permission_resolved").length, 1);
  service.event({ type: "tool.result", toolId: "tool-1", status: "completed", output: "ok", exitCode: 0 });
  assert.equal(events.filter((event) => event.type === "timeline.item" && event.item.callId === "tool-1").at(-1).item.detail.output, "ok");
  await connection.send({ type: "session.interrupt", requestId: "cancel", sessionId: "paseo-session" });
  assert.equal(events.filter((event) => event.type === "session.turn").at(-1).state, "canceled");

  await prompt(connection, "message-2");
  assert.equal(gateCount, 3);
  const denyId = "66666666-6666-4666-8666-666666666666";
  service.event({ type: "tool.requested", toolId: "tool-deny", name: "Bash", input: "{}", target: "Windows" });
  service.event({ type: "approval.requested", approvalId: denyId, toolId: "tool-deny" });
  await connection.send({
    type: "session.permission", sessionId: "paseo-session", permissionId: denyId,
    response: { behavior: "deny", selectedActionId: "deny" },
  });
  assert.equal(service.calls.findLast((call) => call.type === "approval.reply").allowed, false);
  service.sessions.get(sessionId).activeRun = null;
  service.event({ type: "run.status", status: "completed", connectionId: deviceId });
  await connection.send({ type: "session.close", requestId: "close", sessionId: "paseo-session" });
  await connection.close();
  assert.equal(service.closed, true);

  const createdService = new FakeService();
  createdService.sessions.clear();
  const created = await setup(createdService);
  await created.connection.send({
    type: "session.open", requestId: "new", sessionId: "paseo-session",
    config, history: "skip",
  });
  assert.equal(createdService.calls.find((call) => call.type === "session.create").projectPath, project);
  assert.equal(createdService.calls.filter((call) => call.type === "session.configure").length, 0);
  await prompt(created.connection, "new-message");
  assert.equal(created.events.find((event) => event.type === "session.opened").persistence.data.sessionId, sessionId);
  await created.connection.send({ type: "session.interrupt", requestId: "new-cancel", sessionId: "paseo-session" });
  await created.connection.send({ type: "session.close", requestId: "new-close", sessionId: "paseo-session" });
  await created.connection.close();

  const ownedService = new FakeService();
  ownedService.sessions.clear();
  const owned = await setup(ownedService);
  const ownedConfig = { ...config, env: { PASEO_AGENT_ID: "owner-agent" } };
  await open(owned.connection, {
    persistence: undefined, history: "skip", config: { ...ownedConfig, mode: "default" },
  });
  const opened = owned.events.find((event) => event.type === "session.opened");
  assert.ok(opened.capabilities.includes("session.configure"));
  assert.equal(owned.events.find((event) => event.type === "session.config").config.mode, "default");
  assert.deepEqual(ownedService.calls.filter((call) => call.type === "session.configure"), [
    { type: "session.configure", sessionId, permissionMode: "default" },
  ]);
  ownedService.sessions.get(sessionId).model = "keep-model";
  ownedService.sessions.get(sessionId).effort = "high";
  const unrelated = {
    id: "another-session", title: "Other", projectPath: "C:\\elsewhere",
    device: { id: deviceId, name: "Windows" }, permissionMode: "auto",
    activeRun: { id: runId, status: "running" },
  };
  ownedService.sessions.set(unrelated.id, unrelated);
  let finishConfigure;
  ownedService.configureBarrier = new Promise((resolve) => { finishConfigure = resolve; });
  const configuring = owned.connection.send({
    type: "session.configure", requestId: "choose-plan", sessionId: "paseo-session", changes: { mode: "plan" },
  });
  await assert.rejects(prompt(owned.connection, "during-configure"), /尚未就绪/);
  finishConfigure();
  await configuring;
  ownedService.configureBarrier = undefined;
  assert.deepEqual(ownedService.calls.findLast((call) => call.type === "session.configure"),
    { type: "session.configure", sessionId, permissionMode: "plan" });
  assert.equal(ownedService.sessions.get(sessionId).model, "keep-model");
  assert.equal(ownedService.sessions.get(sessionId).effort, "high");
  assert.equal(unrelated.permissionMode, "auto");
  ownedService.sessions.delete(unrelated.id);
  assert.equal(owned.events.filter((event) => event.type === "session.config").at(-1).config.mode, "plan");
  const beforeRejects = ownedService.calls.length;
  for (const changes of [{ mode: "bypassPermissions" }, { mode: "unknown" }, { mode: null },
    { mode: "default", model: "other" }, { mode: "default", thinkingOption: "low" }, { settings: {} }])
    await assert.rejects(owned.connection.send({
      type: "session.configure", requestId: "reject-mode", sessionId: "paseo-session", changes,
    }), /安全审批模式/);
  assert.equal(ownedService.calls.length, beforeRejects);
  await prompt(owned.connection, "owned-running");
  await assert.rejects(owned.connection.send({
    type: "session.configure", requestId: "busy-mode", sessionId: "paseo-session", changes: { mode: "default" },
  }), /未空闲/);
  await owned.connection.send({ type: "session.interrupt", requestId: "owned-cancel", sessionId: "paseo-session" });
  await owned.connection.send({ type: "session.close", requestId: "owned-close", sessionId: "paseo-session" });
  const beforeResume = ownedService.calls.filter((call) => call.type === "session.configure").length;
  const subscriptionsBeforeResume = ownedService.calls.filter((call) => call.type === "session.subscribe").length;
  await assert.rejects(open(owned.connection, {
    config: { ...ownedConfig, mode: "auto" }, persistence: opened.persistence,
  }), /模式与请求不一致/);
  assert.equal(ownedService.calls.filter((call) => call.type === "session.subscribe").length, subscriptionsBeforeResume);
  await open(owned.connection, { config: { ...ownedConfig, mode: "plan" }, persistence: opened.persistence });
  assert.equal(ownedService.calls.filter((call) => call.type === "session.configure").length, beforeResume);
  assert.equal(owned.events.filter((event) => event.type === "session.config").at(-1).config.mode, "plan");
  await owned.connection.send({
    type: "session.configure", requestId: "choose-edits", sessionId: "paseo-session", changes: { mode: "acceptEdits" },
  });
  assert.equal(ownedService.sessions.get(sessionId).permissionMode, "acceptEdits");
  await owned.connection.send({ type: "session.close", requestId: "owned-final-close", sessionId: "paseo-session" });
  await owned.connection.close();
});

test("restores ownership across connections only for the creating Paseo agent and device", async () => {
  const service = new FakeService();
  service.sessions.clear();
  const connectCCDesk = async () => {
    const next = new FakeService();
    next.sessions = service.sessions;
    next.calls = service.calls;
    next.deviceId = service.deviceId;
    next.emptyHistory = true;
    return next;
  };
  const provider = createCCDeskProvider({ connectCCDesk, readEnvironmentGate: async () => passingGate() });
  const connect = async (registration = provider) => {
    const connection = await registration.connect({
      versions: [1], capabilities: ["session.list", "session.persistence", "session.configure"],
    });
    const events = [];
    observe(connection, events);
    return { connection, events };
  };
  const ownerConfig = { ...config, env: { PASEO_AGENT_ID: "creator-agent" }, mode: "auto" };
  const first = await connect();
  await open(first.connection, { persistence: undefined, history: "skip", config: ownerConfig });
  const saved = first.events.find((event) => event.type === "session.opened").persistence;
  await first.connection.send({ type: "session.close", requestId: "first-close", sessionId: "paseo-session" });
  await first.connection.close();

  const restored = await connect();
  await assert.rejects(open(restored.connection, {
    persistence: saved, config: { ...ownerConfig, mode: "default" },
  }), /模式与请求不一致/);
  assert.equal(service.calls.filter((call) => call.type === "session.configure").length, 0);
  await open(restored.connection, { persistence: saved, config: ownerConfig });
  assert.ok(restored.events.find((event) => event.type === "session.opened").capabilities.includes("session.configure"));
  assert.equal(service.calls.filter((call) => call.type === "session.configure").length, 0);
  await restored.connection.send({
    type: "session.configure", requestId: "restored-config", sessionId: "paseo-session", changes: { mode: "default" },
  });
  assert.deepEqual(service.calls.filter((call) => call.type === "session.configure"), [
    { type: "session.configure", sessionId, permissionMode: "default" },
  ]);
  await restored.connection.send({ type: "session.close", requestId: "restored-close", sessionId: "paseo-session" });
  await restored.connection.close();

  const imported = await connect();
  await imported.connection.send({ type: "sessions", requestId: "import-list" });
  const listed = imported.events.find((event) => event.type === "sessions").sessions[0].persistence;
  const claimed = { ...listed, data: { ...listed.data, owned: true, ownerAgentId: "creator-agent" } };
  await open(imported.connection, {
    persistence: claimed, config: { ...ownerConfig, env: { PASEO_AGENT_ID: "import-agent" }, mode: "default" },
  });
  assert.equal(imported.events.find((event) => event.type === "session.opened").capabilities.includes("session.configure"), false);
  await assert.rejects(imported.connection.send({
    type: "session.configure", requestId: "import-config", sessionId: "paseo-session", changes: { mode: "plan" },
  }), /不会修改已有/);
  assert.equal(service.calls.filter((call) => call.type === "session.configure").length, 1);
  await imported.connection.send({ type: "session.close", requestId: "import-close", sessionId: "paseo-session" });
  await imported.connection.close();

  const foreignId = "77777777-7777-4777-8777-777777777777";
  service.sessions.set(foreignId, { ...service.sessions.get(sessionId), id: foreignId });
  const foreign = await connect();
  await foreign.connection.send({ type: "sessions", requestId: "foreign-list" });
  const foreignHandle = foreign.events.find((event) => event.type === "sessions").sessions
    .find((entry) => entry.persistence.data.sessionId === foreignId).persistence;
  await open(foreign.connection, { persistence: foreignHandle, config: { ...ownerConfig, mode: "default" } });
  assert.equal(foreign.events.find((event) => event.type === "session.opened").capabilities.includes("session.configure"), false);
  await foreign.connection.send({ type: "session.close", requestId: "foreign-close", sessionId: "paseo-session" });
  await foreign.connection.close();

  const otherDevice = "88888888-8888-4888-8888-888888888888";
  service.deviceId = otherDevice;
  service.sessions.get(sessionId).device = { id: otherDevice, name: "Other" };
  const moved = await connect();
  await open(moved.connection, {
    persistence: { ...saved, data: { ...saved.data, deviceId: otherDevice } },
    config: { ...ownerConfig, mode: "default" },
  });
  assert.equal(moved.events.find((event) => event.type === "session.opened").capabilities.includes("session.configure"), false);
  await moved.connection.send({ type: "session.close", requestId: "moved-close", sessionId: "paseo-session" });
  await moved.connection.close();

  service.deviceId = deviceId;
  service.sessions.get(sessionId).device = { id: deviceId, name: "Windows" };
  const freshProvider = createCCDeskProvider({ connectCCDesk, readEnvironmentGate: async () => passingGate() });
  const fresh = await connect(freshProvider);
  await open(fresh.connection, { persistence: saved, config: { ...ownerConfig, mode: "default" } });
  assert.equal(fresh.events.find((event) => event.type === "session.opened").capabilities.includes("session.configure"), false);
  await fresh.connection.send({ type: "session.close", requestId: "fresh-close", sessionId: "paseo-session" });
  await fresh.connection.close();
});

test("fails closed for active sessions, unsupported input, gate/channel failures and uncertain or external decisions", async () => {
  const listingService = new FakeService();
  const listingEvents = [];
  const listing = await createCCDeskProvider({ connectCCDesk: async () => listingService, readEnvironmentGate: async () => passingGate() }).connect({
    versions: [1], capabilities: ["session.list"],
  });
  observe(listing, listingEvents);
  await listing.send({ type: "sessions", requestId: "list-with-default-gate" });
  assert.equal(listingEvents.find((event) => event.type === "sessions").sessions.length, 1);
  await listing.close();

  const caller = "private-test-caller-identity";
  const token = "private-test-header-token";
  const url = `http://127.0.0.1:6767/mcp/agents?callerAgentId=${caller}`;
  const builtin = (type = "http", address = url) => ({
    type, url: address, headers: { Authorization: `Bearer ${token}` },
  });
  const builtinConfig = {
    ...config, env: { PASEO_AGENT_ID: caller, PASEO_AGENT_CWD: project },
    mcpServers: { paseo: builtin() },
  };
  const warning = "此 CC Desk 会话未接入 Paseo 内建 MCP，服务端自身 MCP 配置不变";
  for (const [type, address] of [["http", url], ["sse", url], ["http", url.replace(":6767", ":6768")]]) {
    const acceptedService = new FakeService();
    acceptedService.sessions.clear();
    const accepted = await setup(acceptedService);
    const methods = ["log", "info", "warn", "error", "debug"];
    const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
    const logs = [];
    for (const name of methods) console[name] = (...args) => logs.push(args.map((arg) =>
      arg instanceof Error ? arg.message : arg));
    try {
      await open(accepted.connection, {
        persistence: undefined, history: "skip",
        config: { ...builtinConfig, mcpServers: { paseo: builtin(type, address) } },
      });
      const warningIndex = accepted.events.findIndex((event) =>
        event.type === "session.notice" && event.notice.severity === "warning" && event.notice.title === warning);
      const readyIndex = accepted.events.findIndex((event) => event.type === "session.ready");
      assert.ok(warningIndex >= 0 && warningIndex < readyIndex);
      await prompt(accepted.connection, "builtin-message");
      const observed = JSON.stringify({ calls: acceptedService.calls, events: accepted.events, logs });
      for (const privateValue of [caller, token, "Authorization", "callerAgentId"])
        assert.equal(observed.includes(privateValue), false);
      await accepted.connection.send({ type: "session.interrupt", requestId: "builtin-cancel", sessionId: "paseo-session" });
      await accepted.connection.send({ type: "session.close", requestId: "builtin-close", sessionId: "paseo-session" });
      await accepted.connection.close();
    } finally {
      for (const name of methods) console[name] = originals[name];
    }
  }
  const rejectedService = new FakeService();
  const rejected = await setup(rejectedService);
  const malformedExtraField = { paseo: { ...builtin(), command: "unexpected" } };
  malformedMcpFixtures.add(malformedExtraField);
  const rejectedServers = [
    { other: builtin() },
    { paseo: builtin(), other: builtin() },
    { paseo: { type: "stdio", command: "unused" } },
    { paseo: builtin("http", url.replace("127.0.0.1", "localhost")) },
    { paseo: builtin("http", url.replace("127.0.0.1", "127.1")) },
    { paseo: builtin("http", url.replace("http://", "http://user@")) },
    { paseo: builtin("http", url.replace("/mcp/agents", "/mcp/other")) },
    { paseo: builtin("http", "http://127.0.0.1:6767/mcp/agents") },
    { paseo: builtin("http", url.replace("http:", "https:")) },
    { paseo: builtin("http", url + "#fragment") },
    { paseo: builtin("http", url + "&extra=value") },
    { paseo: builtin("http", url + `&callerAgentId=${caller}`) },
    { paseo: builtin("http", url.replace(caller, "other-caller")) },
    malformedExtraField,
  ];
  const methods = ["log", "info", "warn", "error", "debug"];
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
  const rejectedLogs = [];
  for (const name of methods) console[name] = (...args) => rejectedLogs.push(args.map((arg) =>
    arg instanceof Error ? arg.message : arg));
  try {
    for (const mcpServers of rejectedServers)
      await assert.rejects(open(rejected.connection, { config: { ...builtinConfig, mcpServers } }), /MCP/);
    await assert.rejects(open(rejected.connection, {
      config: { ...builtinConfig, env: { PASEO_AGENT_CWD: project } },
    }), /MCP/);
    await assert.rejects(open(rejected.connection, {
      config: { ...builtinConfig, systemPrompt: "custom" },
    }), /系统提示/);
    await assert.rejects(open(rejected.connection, {
      config: { ...builtinConfig, toolPolicy: { preapproved: [] } },
    }), /工具策略/);
  } finally {
    for (const name of methods) console[name] = originals[name];
  }
  assert.equal(rejectedService.calls.length, 0);
  const rejectedOutput = JSON.stringify({ events: rejected.events, logs: rejectedLogs });
  for (const privateValue of [caller, token, "Authorization", "callerAgentId"])
    assert.equal(rejectedOutput.includes(privateValue), false);

  const existingService = new FakeService();
  existingService.sessions.get(sessionId).permissionMode = "plan";
  const existing = await setup(existingService);
  await assert.rejects(open(existing.connection, { config: { ...config, mode: "auto" } }), /模式与请求不一致/);
  assert.equal(existingService.calls.filter((call) => call.type === "session.subscribe").length, 0);
  await open(existing.connection, { config: { ...config, mode: "plan" } });
  assert.equal(existing.events.find((event) => event.type === "session.config").config.mode, "plan");
  assert.equal(existing.events.find((event) => event.type === "session.opened").capabilities.includes("session.configure"), false);
  await assert.rejects(existing.connection.send({
    type: "session.configure", requestId: "existing-mode", sessionId: "paseo-session", changes: { mode: "default" },
  }), /不会修改已有/);
  assert.equal(existingService.calls.filter((call) => call.type === "session.configure").length, 0);
  assert.equal(existingService.sessions.get(sessionId).model, "existing-model");
  assert.equal(existingService.sessions.get(sessionId).effort, "high");
  await existing.connection.send({ type: "session.close", requestId: "existing-close", sessionId: "paseo-session" });
  await existing.connection.close();

  const autoService = new FakeService();
  autoService.sessions.clear();
  const auto = await setup(autoService);
  await open(auto.connection, { persistence: undefined, history: "skip", config: { ...config, mode: "auto" } });
  assert.equal(autoService.calls.filter((call) => call.type === "session.configure").length, 0);
  await auto.connection.send({ type: "session.close", requestId: "auto-close", sessionId: "paseo-session" });
  await auto.connection.close();

  const differingDefaultService = new FakeService();
  differingDefaultService.sessions.clear();
  differingDefaultService.createdMode = "plan";
  const differingDefault = await setup(differingDefaultService);
  await assert.rejects(open(differingDefault.connection, {
    persistence: undefined, history: "skip", config: { ...config, mode: "auto" },
  }), /默认审批模式与 Paseo 默认不一致/);
  assert.equal(differingDefaultService.calls.filter((call) => call.type === "session.configure").length, 0);
  assert.equal(differingDefaultService.sessions.get(sessionId).permissionMode, "plan");
  await differingDefault.connection.close();

  const unsafeService = new FakeService();
  unsafeService.sessions.clear();
  const unsafe = await setup(unsafeService);
  await assert.rejects(open(unsafe.connection, {
    persistence: undefined, history: "skip", config: { ...config, mode: "bypassPermissions" },
  }), /不支持此审批模式/);
  assert.equal(unsafeService.calls.length, 0);
  const unsafeExistingService = new FakeService();
  unsafeExistingService.sessions.get(sessionId).permissionMode = "bypassPermissions";
  const unsafeExisting = await setup(unsafeExistingService);
  await assert.rejects(open(unsafeExisting.connection), /审批模式未知或不受支持/);
  assert.equal(unsafeExistingService.calls.filter((call) => call.type === "session.configure").length, 0);

  const failedModeService = new FakeService();
  failedModeService.sessions.clear();
  failedModeService.failConfigure = true;
  const failedMode = await setup(failedModeService);
  await assert.rejects(open(failedMode.connection, {
    persistence: undefined, history: "skip", config: { ...config, mode: "default" },
  }), /审批模式变更未确认/);
  assert.equal(failedModeService.calls.filter((call) => call.type === "session.configure").length, 1);

  const service = new FakeService();
  let report = passingGate();
  const { connection } = await setup(service, async () => report);
  service.sessions.get(sessionId).activeRun = { id: runId, status: "running" };
  await assert.rejects(open(connection), /正在运行/);
  assert.equal(service.calls.length, 0);
  service.sessions.get(sessionId).activeRun = null;
  await assert.rejects(open(connection, { config: { ...config, systemPrompt: "ignored?" } }), /系统提示/);
  await assert.rejects(open(connection, { config: { ...config, mcpServers: { x: { type: "stdio", command: "unused" } } } }), /MCP/);
  await assert.rejects(open(connection, { config: { ...config, env: { USER_SETTING: "x" } } }), /环境/);
  await assert.rejects(open(connection, { config: { ...config, env: { CCDESK_PREFLIGHT_SCRIPT: "C:\\untrusted\\preflight.ps1" } } }), /环境/);
  await open(connection, { config: { ...config, env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: project } } });
  await assert.rejects(open(connection), /一次只支持一个/);
  const subscriptions = service.calls.filter((call) => call.type === "session.subscribe").length;
  assert.equal(subscriptions, 1);
  await assert.rejects(prompt(connection, "image", [{ type: "image", data: "x", mimeType: "image/png" }]), /附件/);
  for (const denied of [null, [], {}, { allow: false }, { allow: "true" }]) {
    report = denied;
    await assert.rejects(prompt(connection, "gate-fail"), /前置检查未明确允许/);
  }
  assert.equal(service.trace.includes("channel"), false);
  report = passingGate();
  service.ready = false;
  await assert.rejects(prompt(connection, "channel-fail"), /channel not ready/);
  assert.equal(service.calls.filter((call) => call.type === "message.send").length, 0);
  service.ready = true;
  for (const channelResult of [false, null, 0]) {
    service.channelResult = channelResult;
    await assert.rejects(prompt(connection, "channel-uncertain"), /SSH 通道未就绪/);
    assert.equal(service.calls.filter((call) => call.type === "message.send").length, 0);
  }
  service.channelResult = undefined;
  service.failSend = true;
  await assert.rejects(prompt(connection, "unknown"), /connection lost/);
  await assert.rejects(prompt(connection, "no-retry"), /结果未知/);
  assert.equal(service.calls.filter((call) => call.type === "message.send").length, 1);

  const cancelService = new FakeService();
  let releaseGate;
  const gateWaiting = new Promise((resolve) => { releaseGate = resolve; });
  let gateCalls = 0;
  const cancel = await setup(cancelService, async () => { if (gateCalls++ > 0) await gateWaiting; return passingGate(); });
  await open(cancel.connection);
  const pending = prompt(cancel.connection, "cancel-before-send");
  await Promise.resolve();
  await cancel.connection.send({ type: "session.interrupt", requestId: "cancel-check", sessionId: "paseo-session" });
  releaseGate();
  await assert.rejects(pending, /取消/);
  assert.equal(cancelService.calls.filter((call) => call.type === "message.send").length, 0);

  const otherDeviceService = new FakeService();
  otherDeviceService.sessions.set("other-session", {
    id: "other-session", title: "Other device", projectPath: "D:\\other",
    device: { id: "other-device", name: "Other" }, activeRun: { id: runId, status: "running" },
  });
  const separate = await setup(otherDeviceService);
  await open(separate.connection);
  await prompt(separate.connection, "other-device-active");
  otherDeviceService.sessions.get(sessionId).activeRun = null;
  otherDeviceService.event({ type: "run.status", status: "completed", connectionId: deviceId });
  await separate.connection.send({ type: "session.close", requestId: "separate-close", sessionId: "paseo-session" });
  await separate.connection.close();
  assert.equal(otherDeviceService.closed, true);

  const sameDeviceService = new FakeService();
  sameDeviceService.sessions.set("same-device-session", {
    id: "same-device-session", title: "Same device", projectPath: "C:\\elsewhere",
    device: { id: deviceId, name: "Windows" }, activeRun: { id: runId, status: "running" },
  });
  const sameDevice = await setup(sameDeviceService);
  await assert.rejects(open(sameDevice.connection), /本设备存在正在运行/);
  assert.equal(sameDeviceService.calls.filter((call) => call.type === "session.subscribe").length, 0);

  const missingDeviceService = new FakeService();
  missingDeviceService.deviceId = undefined;
  const missingDevice = await setup(missingDeviceService);
  await assert.rejects(missingDevice.connection.send({ type: "sessions", requestId: "missing-device" }), /接口不完整/);

  const targetService = new FakeService();
  targetService.sessions.get(sessionId).device = { id: "other-device", name: "Other" };
  targetService.sessions.get(sessionId).activeRun = { id: runId, status: "running" };
  const target = await setup(targetService);
  await assert.rejects(open(target.connection, {
    persistence: { version: 1, data: { sessionId, projectPath: project, deviceId: "other-device" } },
  }), /正在运行/);
  assert.equal(targetService.calls.filter((call) => call.type === "session.subscribe").length, 0);

  const movedService = new FakeService();
  const moved = await setup(movedService);
  await open(moved.connection);
  const changed = movedService.sessions.get(sessionId);
  changed.projectPath = "C:\\other";
  movedService.emit("message", { type: "session.updated", session: changed });
  await assert.rejects(prompt(moved.connection, "moved"), /绑定已改变/);
  assert.equal(movedService.calls.filter((call) => call.type === "message.send").length, 0);

  const other = new FakeService();
  const external = await setup(other);
  await open(external.connection);
  await prompt(external.connection);
  other.event({ type: "tool.requested", toolId: "tool-2", name: "Bash", input: "{}", target: "Windows" });
  other.event({ type: "approval.requested", approvalId, toolId: "tool-2" });
  other.event({ type: "approval.resolved", approvalId, allowed: true });
  assert.equal(external.events.filter((event) => event.type === "session.permission_resolved").length, 0);
  assert.match(external.events.find((event) => event.type === "session.notice" && event.notice.severity === "error").notice.title, /其他窗口/);
  await assert.rejects(external.connection.close(), /运行尚未结束/);
  assert.equal(other.closed, undefined);
  other.sessions.get(sessionId).activeRun = null;
  other.event({ type: "run.status", status: "completed", connectionId: deviceId });
  await assert.rejects(prompt(external.connection, "blocked"), /其他窗口/);
});

test("agent launch and session input cannot replace the daemon preflight script", async () => {
  const original = process.env.CCDESK_PREFLIGHT_SCRIPT;
  const trusted = "C:\\trusted\\preflight.ps1";
  const untrusted = "C:\\untrusted\\preflight.ps1";
  process.env.CCDESK_PREFLIGHT_SCRIPT = trusted;
  try {
    const service = new FakeService();
    const executed = [];
    const provider = createCCDeskProvider({
      connectCCDesk: async () => service,
      readEnvironmentGate: () => readEnvironmentGate({ execute: async (_file, args) => {
        executed.push(args.at(-1));
        return { stdout: '{"allow":true}' };
      } }),
    });
    const connection = await provider.connect({
      versions: [1], capabilities: ["prompt.message", "session.persistence"],
      launch: { command: "unused", args: [], env: { CCDESK_PREFLIGHT_SCRIPT: untrusted } },
    });
    observe(connection, []);
    await assert.rejects(open(connection, {
      config: { ...config, env: { CCDESK_PREFLIGHT_SCRIPT: untrusted } },
    }), /环境/);
    assert.equal(service.calls.length, 0);
    await open(connection);
    await prompt(connection);
    assert.deepEqual(executed, [trusted, trusted]);
    await connection.send({ type: "session.interrupt", requestId: "cancel-gate-test", sessionId: "paseo-session" });
    await connection.send({ type: "session.close", requestId: "close-gate-test", sessionId: "paseo-session" });
    await connection.close();
  } finally {
    if (original === undefined) delete process.env.CCDESK_PREFLIGHT_SCRIPT;
    else process.env.CCDESK_PREFLIGHT_SCRIPT = original;
  }
});
