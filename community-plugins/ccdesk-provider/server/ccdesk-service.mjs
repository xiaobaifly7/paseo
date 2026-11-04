import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const VERSION = '0.3.9';
const PROTOCOL = 22;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWN_COMMAND = /^(?:session\.(?:subscribe|history|status|configure|move|delete|rename|fork|compact)|message\.send|run\.(?:cancel|continue|task\.(?:stop|background))|approval\.reply|terminal\.(?:open|close|input|resize|ack))$/;
const ERROR_CODES = new Set([
  'unauthorized', 'version_mismatch', 'tunnel_failed', 'ssh_failed', 'connection_lost',
  'client_failed', 'execution_offline', 'device_offline', 'run_active', 'run_inactive',
  'run_finishing', 'approval_inactive', 'approval_answered', 'request_conflict',
  'session_busy', 'native_busy', 'native_unavailable', 'native_context_missing',
  'device_unknown', 'fork_point', 'input_busy', 'instructions_changed', 'instructions_failed',
  'invalid_command', 'invalid_cursor', 'login_failed', 'login_inactive', 'logout_failed', 'not_found', 'not_owner',
  'service_upgrading', 'terminal_failed', 'terminal_inactive', 'update_unavailable',
  'updates_unavailable', 'web_certificate_domain', 'web_certificate_invalid', 'web_certificate_save',
]);

class ServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const failure = (message, code = 'connection_failed') => new ServiceError(message, code);
const safeCode = (code, fallback) => ERROR_CODES.has(code) ? code : fallback;
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

async function readConfig(location) {
  const configFailure = (message, code) => {
    const error = failure(message, code);
    error.stack = `${error.name}: ${message}`;
    return error;
  };
  if (!location.roaming) throw configFailure('未设置 APPDATA 环境变量', 'config_appdata_missing');
  let text;
  try {
    text = await readFile(join(location.roaming, 'ccdt', 'config.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw configFailure('CC Desk 配置文件不存在', 'config_not_found');
    if (error?.code === 'EACCES' || error?.code === 'EPERM')
      throw configFailure('没有权限读取 CC Desk 配置', 'config_permission_denied');
    throw configFailure('读取 CC Desk 配置时发生 I/O 错误', 'config_io_error');
  }
  try { return JSON.parse(text); }
  catch { throw configFailure('CC Desk 配置 JSON 无效', 'config_invalid_json'); }
}

async function readDeviceId(location) {
  const settings = JSON.parse(await readFile(join(location.roaming, 'CC Desk Tunnel', 'settings.json'), 'utf8'));
  return settings.deviceId;
}

function reveal(kept) {
  if (!isAbsolute(process.env.SystemRoot ?? '')) throw new Error('SystemRoot must be an absolute path');
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "Add-Type -AssemblyName System.Security; $v = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($v, $null, 'CurrentUser'))";
  const result = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: kept.data, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'ignore'],
  });
  return Buffer.from(result.trim(), 'base64').toString('utf8');
}

async function loadRuntime() {
  const resources = join(process.env.LOCALAPPDATA, 'Programs', 'CC Desk Tunnel', 'resources');
  const app = join(resources, 'app.asar');
  const { version } = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  if (version !== VERSION) throw failure('CC Desk 客户端版本不匹配', 'version_mismatch');
  const { openProxyBridge, connectService, certificateMatches } = await import(pathToFileURL(join(app, 'electron', 'proxy-bridge.mjs')).href);
  return {
    version, openProxyBridge, connectService, certificateMatches, WebSocket,
    components: {
      openssh: join(resources, 'vendor', 'openssh'),
      powershell: join(resources, 'vendor', 'pwsh', 'pwsh.exe'),
      scriptDirectory: join(resources, 'app.asar.unpacked', 'electron'),
    },
  };
}

function selectServer(config) {
  const matches = Array.isArray(config?.servers) ? config.servers.filter((server) => {
    if (typeof server?.url !== 'string') return false;
    const match = /^wss:\/\/(localhost|\[[a-f0-9:.]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::([1-9]\d{0,4}))?\/ws$/i.exec(server.url);
    if (!match || (match[2] && Number(match[2]) > 65535)) return false;
    if (match[1].toLowerCase() === 'localhost') return true;
    if (match[1].startsWith('[')) {
      try { return new URL(server.url).hostname === '[::1]'; } catch { return false; }
    }
    return isIP(match[1]) === 4 && match[1].startsWith('127.');
  }) : [];
  if (matches.length !== 1) throw failure('CC Desk 服务地址不匹配或不唯一', 'config_mismatch');
  const server = matches[0];
  if (!/^wss:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/ws$/i.test(server.url))
    throw failure('CC Desk 仅支持 127.0.0.1 回环地址', 'config_mismatch');
  if (typeof server.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(server.fingerprint.replaceAll(':', '')))
    throw failure('CC Desk 证书指纹无效', 'config_mismatch');
  if (server.token?.store !== 'dpapi' || typeof server.token.data !== 'string' || !server.token.data)
    throw failure('CC Desk DPAPI 凭据不可用', 'config_mismatch');
  return server;
}

function preflight(runtime, server, token, deviceId) {
  const address = new URL(server.url);
  return new Promise((resolve, reject) => {
    let socket, finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.terminate(); }
      catch { error = failure('CC Desk 预检连接关闭失败', 'cleanup_failed'); }
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(failure('CC Desk 预检超时', 'preflight_failed')), 45000);
    try {
      socket = new runtime.WebSocket(address, {
        handshakeTimeout: 15000,
        createConnection: (_options, created) => {
          Promise.resolve().then(() => runtime.connectService(address, { fingerprint: server.fingerprint }, async () => 'DIRECT'))
            .then((connection) => {
              if (finished) connection.destroy();
              else created(null, connection);
            }).catch(() => { if (!finished) created(failure('CC Desk 预检连接失败', 'preflight_failed')); });
        },
      });
    } catch { finish(failure('CC Desk 预检连接失败', 'preflight_failed')); return; }
    socket.once('open', () => {
      let verified = false;
      try { verified = runtime.certificateMatches(socket._socket.getPeerCertificate().fingerprint256, server.fingerprint); } catch {}
      if (!verified) { finish(failure('CC Desk 服务证书指纹不匹配', 'certificate_mismatch')); return; }
      try { socket.send(JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL, token, deviceName: hostname(), tunnel: false })); }
      catch { finish(failure('CC Desk 预检认证发送失败', 'preflight_failed')); }
    });
    socket.on('message', (raw, binary) => {
      let message;
      try { if (binary) throw new Error(); message = JSON.parse(raw.toString('utf8')); }
      catch { finish(failure('CC Desk 预检响应无效', 'preflight_failed')); return; }
      if (message?.type === 'connection.error') {
        const code = safeCode(message.code, 'preflight_failed');
        finish(failure(`CC Desk 预检失败 (${code})`, code));
        return;
      }
      if (message?.type !== 'ready' || message.protocolVersion !== PROTOCOL || message.version !== VERSION || message.adapter !== 'claude-code') {
        finish(failure('CC Desk 预检版本或响应不匹配', 'version_mismatch'));
        return;
      }
      if (!UUID.test(message.connectionId) || !Array.isArray(message.sessions)) {
        finish(failure('CC Desk 预检身份或会话无效', 'identity_mismatch'));
        return;
      }
      for (const session of message.sessions) {
        if (!session || typeof session !== 'object' || !Object.hasOwn(session, 'activeRun') ||
          (session.activeRun !== null && (typeof session.activeRun !== 'object' || Array.isArray(session.activeRun)))) {
          finish(failure('CC Desk 预检会话状态无效', 'identity_mismatch'));
          return;
        }
        if (session.activeRun !== null) {
          if (!UUID.test(session.device?.id)) { finish(failure('活动会话的设备身份未知', 'identity_mismatch')); return; }
          if (sameId(session.device.id, deviceId)) { finish(failure('本机设备有活动任务，已拒绝建立执行隧道', 'device_busy')); return; }
        }
      }
      finish();
    });
    socket.on('error', () => finish(failure('CC Desk 预检连接失败', 'preflight_failed')));
    socket.once('close', () => finish(failure('CC Desk 预检连接已关闭', 'preflight_failed')));
  });
}

class Service extends EventEmitter {
  #deviceId;
  #isolated;
  #socket;
  #bridge;
  #waiting = new Map();
  #owners = new Map();
  #openingReject;
  #ended = false;
  #closing = false;
  #cleanupError;
  #resolveClosed;

  constructor(deviceId, isolated) {
    super();
    this.#deviceId = deviceId;
    this.#isolated = isolated;
    this.sessions = new Map();
    this.devices = [];
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
  }

  get deviceId() { return this.#deviceId; }

  async start(runtime, server, token) {
    try {
      const bridge = await runtime.openProxyBridge(
        { url: server.url, fingerprint: server.fingerprint },
        { ...runtime.components, environment: {}, log: () => {}, resolveProxy: async () => 'DIRECT' },
        () => this.#finish(true),
      );
      if (this.#ended) {
        try { await bridge.close(true); }
        catch { throw failure('CC Desk 本地桥清理失败', 'cleanup_failed'); }
        throw failure('CC Desk 连接已关闭');
      }
      this.#bridge = bridge;
      if (!/^ws:\/\/127\.0\.0\.1:\d+\/bridge\/[a-f0-9]{64}$/.test(bridge.url))
        throw failure('CC Desk 本地桥地址无效');
      await new Promise((resolve, reject) => {
        this.#openingReject = reject;
        const socket = this.#socket = new runtime.WebSocket(bridge.url);
        socket.once('open', () => {
          try {
            this.#send({ type: 'auth', protocolVersion: PROTOCOL, token, deviceName: hostname() });
            if (!this.#isolated) this.#send({ type: 'device', id: this.#deviceId });
          } catch {
            this.#fail(failure('CC Desk 认证发送失败'));
          }
        });
        socket.on('message', (raw) => {
          let message;
          try { message = JSON.parse(raw.toString('utf8')); } catch { this.#fail(failure('CC Desk 消息格式无效')); return; }
          if (message.type === 'devices') this.devices = message.devices;
          if (message.type === 'ready') {
            if (message.protocolVersion !== PROTOCOL || message.version !== VERSION || message.adapter !== 'claude-code') {
              this.#fail(failure('CC Desk 服务版本或类型不匹配', 'version_mismatch'));
              return;
            }
            if (!UUID.test(message.connectionId) || !Array.isArray(message.sessions) || !Array.isArray(this.devices)) {
              this.#fail(failure('CC Desk 连接身份无效', 'identity_mismatch'));
              return;
            }
            if (this.#isolated && (this.devices.some((device) => sameId(device.id, this.#deviceId)) ||
              message.sessions.some((session) => sameId(session.device?.id, this.#deviceId)))) {
              this.#fail(failure('测试设备 ID 已被其他设备或会话使用', 'identity_mismatch'));
              return;
            }
            for (const session of message.sessions) this.#remember(session);
            this.connectionId = message.connectionId;
            this.version = message.version;
            if (this.#isolated) {
              try { this.#send({ type: 'device', id: this.#deviceId }); }
              catch { this.#fail(failure('CC Desk 设备身份发送失败')); return; }
            }
            this.#openingReject = undefined;
            resolve();
          } else if (message.type === 'session.updated') this.#remember(message.session);
          else if (message.type === 'session.deleted') {
            this.sessions.delete(message.sessionId);
            this.#owners.delete(message.sessionId);
          }
          else if (message.type === 'connection.error') {
            const code = typeof message.message === 'string' && message.message.includes('证书指纹不匹配')
              ? 'certificate_mismatch' : safeCode(message.code, 'connection_failed');
            message = { type: 'connection.error', code };
            if (this.#openingReject) { this.#fail(failure(`CC Desk 连接失败 (${code})`, code)); return; }
          } else if (message.type === 'response' && !message.ok) {
            message = { type: 'response', requestId: message.requestId, ok: false, code: safeCode(message.code, 'request_failed') };
          }
          const waiting = this.#waiting.get(message.requestId);
          if (waiting) {
            this.#waiting.delete(message.requestId);
            if (message.type === 'response' && !message.ok) waiting.reject(failure(`CC Desk 请求失败 (${message.code})`, message.code));
            else waiting.resolve(message);
          }
          this.emit('message', message);
        });
        socket.once('close', () => this.#finish(!this.#closing));
        socket.on('error', () => this.#fail(failure('CC Desk 本地连接失败')));
      });
      await this.channel();
    } catch (error) {
      this.#finish(true);
      await this.closed;
      if (this.#cleanupError) throw this.#cleanupError;
      throw error instanceof ServiceError ? error : failure('CC Desk 连接失败');
    }
  }

  #fail(error) {
    this.#openingReject?.(error);
    this.#openingReject = undefined;
    this.#finish(true);
  }

  #remember(session) {
    this.sessions.set(session.id, session);
    this.#owners.set(session.id, session.device?.id);
  }

  #finish(lost) {
    if (this.#ended) return;
    this.#ended = true;
    this.lost = lost;
    this.#openingReject?.(failure('CC Desk 连接已关闭'));
    this.#openingReject = undefined;
    for (const { reject } of this.#waiting.values()) reject(failure('CC Desk 连接已关闭'));
    this.#waiting.clear();
    this.#socket?.terminate();
    Promise.resolve().then(() => this.#bridge?.close(true)).catch(() => {
      this.#cleanupError = failure('CC Desk 本地桥清理失败', 'cleanup_failed');
    }).then(() => this.#resolveClosed());
    this.emit('end', lost);
  }

  #check(message) {
    if (!message || typeof message.type !== 'string' || /^(?:auth|device|leave|tunnel\.)/.test(message.type))
      throw failure('CC Desk 消息类型无效', 'invalid_command');
    if (this.#isolated && message.type !== 'session.create') {
      if (!OWN_COMMAND.test(message.type) || !sameId(this.#owners.get(message.sessionId), this.#deviceId))
        throw failure('测试设备只能操作自己的会话', 'identity_mismatch');
    }
  }

  #send(message) {
    if (this.#ended || this.#socket?.readyState !== 1) throw failure('CC Desk 连接已关闭');
    try { this.#socket.send(JSON.stringify(message)); } catch { throw failure('CC Desk 消息发送失败'); }
  }

  request(command) {
    try { this.#check(command); } catch (error) { return Promise.reject(error); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.#waiting.set(requestId, { resolve, reject });
      try { this.#send({ ...command, requestId }); }
      catch (error) { this.#waiting.delete(requestId); reject(error); }
    });
  }

  send(message) {
    this.#check(message);
    this.#send(message);
  }

  async channel(timeoutMs = 60000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure('等待时间无效');
    const ready = () => this.devices.some((device) => sameId(device.id, this.#deviceId) && device.ready === true);
    if (this.#ended) throw failure('CC Desk 连接已关闭');
    if (ready()) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        this.off('message', check);
        this.off('end', ended);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (ready()) finish(); };
      const ended = () => finish(failure('CC Desk 连接已关闭'));
      const timer = setTimeout(() => finish(failure('设备身份不匹配或执行通道未就绪', 'identity_mismatch')), timeoutMs);
      this.on('message', check);
      this.on('end', ended);
      check();
    });
  }

  async close() {
    if (!this.#ended) {
      this.#closing = true;
      if (this.#socket?.readyState === 1) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          this.#socket.once('close', () => { clearTimeout(timer); resolve(); });
          this.#socket.close();
        });
      }
      this.#finish(false);
    }
    await this.closed;
    if (this.#cleanupError) throw this.#cleanupError;
  }
}

export async function connectCCDesk(options = {}) {
  const dependencies = { readConfig, readDeviceId, reveal, loadRuntime, ...options.dependencies };
  const location = { roaming: process.env.APPDATA };
  let server, currentDevice, runtime, token;
  try { server = selectServer(await dependencies.readConfig(location)); }
  catch (error) { throw error instanceof ServiceError ? error : failure('无法读取 CC Desk 配置', 'config_mismatch'); }
  try { currentDevice = await dependencies.readDeviceId(location); }
  catch { throw failure('无法读取桌面设备身份', 'identity_mismatch'); }
  if (!UUID.test(currentDevice) || (options.deviceId !== undefined && (!UUID.test(options.deviceId) || sameId(options.deviceId, currentDevice))))
    throw failure('设备身份无效或与现有桌面设备相同', 'identity_mismatch');
  try { runtime = await dependencies.loadRuntime(); }
  catch (error) { throw error instanceof ServiceError ? error : failure('无法加载 CC Desk 原厂组件'); }
  if (runtime.version !== VERSION || typeof runtime.openProxyBridge !== 'function' || typeof runtime.WebSocket !== 'function' ||
    typeof runtime.connectService !== 'function' || typeof runtime.certificateMatches !== 'function')
    throw failure('CC Desk 客户端版本或组件不匹配', 'version_mismatch');
  try { token = await dependencies.reveal(server.token); }
  catch { throw failure('无法解密 CC Desk 凭据', 'unauthorized'); }
  if (typeof token !== 'string' || token.length < 24 || token.length > 512)
    throw failure('CC Desk 凭据无效', 'unauthorized');
  if (options.deviceId === undefined) await preflight(runtime, server, token, currentDevice);
  const service = new Service(options.deviceId ?? currentDevice, options.deviceId !== undefined);
  await service.start(runtime, server, token);
  token = undefined;
  return service;
}
