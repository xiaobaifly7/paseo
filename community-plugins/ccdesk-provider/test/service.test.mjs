import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import urlBuiltin from 'node:url';
import { inspect } from 'node:util';
import test from 'node:test';
import { connectCCDesk } from '../server/ccdesk-service.mjs';

const desktopId = '11111111-1111-4111-8111-111111111111';
const testId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const token = 'FAKE_TEST_TOKEN_12345678901234567890';
const address = 'wss://127.0.0.1:18787/ws';
const fingerprint = 'ab'.repeat(32);
const server = () => ({ url: address, fingerprint, token: { store: 'dpapi', data: 'ZmFrZQ==' } });

function harness({ isolated = false, sessions = [], devices = [], version = '0.3.9', respond = true, connectionFailure, cleanupFails = false, earlyClose = false, preflightSessions = [], preflightFailure, preflightVersion = '0.3.9', pinMatches = true } = {}) {
  const state = { calls: [], sent: [], closed: 0, socket: undefined, bridge: undefined, preflightSent: [], preflightClosed: 0, preflightConnects: 0 };
  class Socket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.readyState = 0;
      this.preflight = options !== undefined;
      if (this.preflight) {
        queueMicrotask(() => options.createConnection({}, (error, connection) => {
          if (error) { this.emit('error', error); return; }
          this._socket = connection;
          this.readyState = 1;
          this.emit('open');
        }));
      } else {
        state.socket = this;
        queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
      }
    }
    receive(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
    send(data) {
      const message = JSON.parse(data);
      if (this.preflight) {
        state.preflightSent.push(message);
        state.pinCheckedBeforeAuth = state.pinChecked;
        queueMicrotask(() => this.receive(preflightFailure
          ? { type: 'connection.error', ...preflightFailure }
          : { type: 'ready', connectionId, version: preflightVersion, protocolVersion: 22, adapter: 'claude-code', sessions: preflightSessions }));
        return;
      }
      state.sent.push(message);
      if (message.type === 'auth') queueMicrotask(() => {
        if (connectionFailure) { this.receive({ type: 'connection.error', ...connectionFailure }); return; }
        this.receive({ type: 'devices', devices });
        if (isolated) this.receive({ type: 'ready', connectionId, version, protocolVersion: 22, adapter: 'claude-code', sessions });
      });
      else if (message.type === 'device') queueMicrotask(() => {
        this.receive({ type: 'devices', devices: [...devices, { id: message.id, name: 'test', ready: true }] });
        if (!isolated) this.receive({ type: 'ready', connectionId, version, protocolVersion: 22, adapter: 'claude-code', sessions });
      });
      else if (message.requestId && respond) queueMicrotask(() => this.receive({ type: 'response', requestId: message.requestId, ok: true }));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.preflight) state.preflightClosed++;
      this.emit('close');
    }
    terminate() { this.close(); }
  }
  const dependencies = {
    async readConfig() { state.calls.push('config'); return { servers: [server()] }; },
    async readDeviceId() { state.calls.push('device'); return desktopId; },
    async reveal() { state.calls.push('reveal'); return token; },
    async loadRuntime() {
      state.calls.push('runtime');
      return {
        version: '0.3.9', WebSocket: Socket, components: {},
        async connectService(target, config, resolveProxy) {
          state.preflightConnects++;
          state.preflightTarget = String(target);
          state.preflightConfig = config;
          state.preflightRoute = await resolveProxy();
          return { getPeerCertificate: () => ({ fingerprint256: pinMatches ? fingerprint : 'ff'.repeat(32) }), destroy() {} };
        },
        certificateMatches(observed, trusted) {
          state.pinChecked = true;
          return observed === trusted;
        },
        async openProxyBridge(config, components, onClosed) {
          state.calls.push('bridge');
          state.bridge = { config, components };
          if (earlyClose) onClosed();
          return { url: `ws://127.0.0.1:12345/bridge/${'a'.repeat(64)}`, async close(notify) { assert.equal(notify, true); state.closed++; if (cleanupFails) throw new Error(token); } };
        },
      };
    },
  };
  return { state, dependencies };
}

test('rejects remote address, invalid pin, credential store, device ID and version before opening a bridge', async () => {
  for (const bad of [
    { ...server(), url: 'wss://example.com:18787/ws' },
    { ...server(), fingerprint: '' },
    { ...server(), token: { store: 'file', data: 'fake' } },
    { ...server(), token: { store: 'dpapi', data: '' } },
  ]) {
    const { state, dependencies } = harness();
    dependencies.readConfig = async () => ({ servers: [bad] });
    await assert.rejects(connectCCDesk({ dependencies }), { code: 'config_mismatch' });
    assert.deepEqual(state.calls, []);
  }
  const first = harness();
  await assert.rejects(connectCCDesk({ deviceId: desktopId, dependencies: first.dependencies }), { code: 'identity_mismatch' });
  assert.deepEqual(first.state.calls, ['config', 'device']);
  const second = harness();
  second.dependencies.loadRuntime = async () => ({ version: '0.3.8' });
  await assert.rejects(connectCCDesk({ dependencies: second.dependencies }), { code: 'version_mismatch' });
  assert.deepEqual(second.state.calls, ['config', 'device']);
});

test('selects the single loopback service and uses its address for preflight and bridge', async () => {
  for (const url of [
    'wss://127.0.0.1:18787/ws',
    'wss://127.0.0.1:29123/ws',
    'wss://127.0.0.1:32100/ws',
    'wss://127.0.0.1/ws',
  ]) {
    const { state, dependencies } = harness();
    dependencies.readConfig = async () => ({ servers: [{ ...server(), url: 'wss://example.com:443/ws' }, { ...server(), url }] });
    const service = await connectCCDesk({ dependencies });
    assert.equal(state.preflightTarget, new URL(url).href);
    assert.equal(state.preflightRoute, 'DIRECT');
    assert.deepEqual(state.bridge.config, { url, fingerprint });
    assert.equal(await state.bridge.components.resolveProxy(url), 'DIRECT');
    await service.close();
    assert.equal(state.preflightClosed, 1);
    assert.equal(state.closed, 1);
  }
});

test('rejects ambiguous local services before reading identity or credentials', async () => {
  for (const urls of [
    ['wss://127.0.0.1:18787/ws', 'wss://127.0.0.1:29123/ws'],
    ['wss://127.0.0.1:18787/ws', 'wss://127.0.0.2:29123/ws'],
    ['wss://127.0.0.1:18787/ws', 'wss://localhost:18787/ws'],
    ['wss://127.0.0.1:18787/ws', 'wss://[::1]:29123/ws'],
    ['wss://127.0.0.1:18787/ws', 'wss://[0:0:0:0:0:0:0:1]:29123/ws'],
    [address, address],
  ]) {
    const { state, dependencies } = harness();
    dependencies.readConfig = async () => ({ servers: urls.map((url) => ({ ...server(), url })) });
    await assert.rejects(connectCCDesk({ dependencies }), { code: 'config_mismatch' });
    assert.deepEqual(state.calls, []);
    assert.equal(state.preflightConnects, 0);
  }
  const { state, dependencies } = harness();
  dependencies.readConfig = async () => ({ servers: [server(), { ...server(), url: 'wss://127.0.0.1:29123/ws', token: { store: 'file', data: 'fake' } }] });
  await assert.rejects(connectCCDesk({ dependencies }), { code: 'config_mismatch' });
  assert.deepEqual(state.calls, []);
});

test('rejects remote, malformed and unsupported loopback service URLs without opening a connection', async () => {
  for (const url of [
    'wss://192.0.2.1:18787/ws',
    'wss://example.com:18787/ws',
    'wss://localhost.example.com:18787/ws',
    'wss://localhost:18787/ws',
    'wss://127.1:18787/ws',
    'wss://127.0.0.2:18787/ws',
    'wss://[::1]:18787/ws',
    'wss://[::::]:18787/ws',
    'ws://127.0.0.1:18787/ws',
    'wss://user@127.0.0.1:18787/ws',
    'wss://127.0.0.1:0/ws',
    'wss://127.0.0.1:65536/ws',
    'wss://127.0.0.1:018787/ws',
    'wss://127.0.0.1:18787/',
    'wss://127.0.0.1:18787/ws/',
    'wss://127.0.0.1:18787/a/../ws',
    'wss://127.0.0.1:18787/%77s',
    'wss://127.0.0.1:18787/ws?',
    'wss://127.0.0.1:18787/ws?x=1',
    'wss://127.0.0.1:18787/ws#',
    'wss://127.0.0.1:18787/ws#fragment',
    ' wss://127.0.0.1:18787/ws',
  ]) {
    const { state, dependencies } = harness();
    dependencies.readConfig = async () => ({ servers: [{ ...server(), url }] });
    await assert.rejects(connectCCDesk({ dependencies }), { code: 'config_mismatch' });
    assert.deepEqual(state.calls, []);
    assert.equal(state.preflightConnects, 0);
  }
});

test('uses the desktop identity, pinned loopback address and DIRECT bridge; requests and events work', async () => {
  const { state, dependencies } = harness();
  const service = await connectCCDesk({ dependencies });
  assert.ok(service instanceof EventEmitter);
  assert.equal(service.deviceId, desktopId);
  assert.throws(() => { service.deviceId = testId; }, TypeError);
  assert.equal(service.deviceId, desktopId);
  assert.equal(state.sent[0].type, 'auth');
  assert.equal(state.sent[1].id, desktopId);
  assert.deepEqual(state.bridge.config, { url: address, fingerprint });
  assert.equal(await state.bridge.components.resolveProxy(address), 'DIRECT');
  assert.ok(service.sessions instanceof Map);
  assert.equal(service.devices.find((device) => device.id === desktopId).ready, true);
  await service.channel(20);
  const response = await service.request({ type: 'usage.summary' });
  assert.equal(response.ok, true);
  assert.equal(state.sent.at(-1).type, 'usage.summary');
  const observed = [];
  service.on('message', (message) => observed.push(message.type));
  state.socket.receive({ type: 'session.updated', session: { id: sessionId, device: { id: desktopId } } });
  assert.equal(service.sessions.get(sessionId).device.id, desktopId);
  assert.deepEqual(observed, ['session.updated']);
  await service.close();
  assert.equal(state.closed, 1);
  assert.equal(state.sent.some((message) => message.type === 'leave'), false);
});

test('isolated identity is registered only after collision checks and cannot control another device', async () => {
  const existing = { id: sessionId, device: { id: desktopId } };
  const { state, dependencies } = harness({ isolated: true, sessions: [existing] });
  const service = await connectCCDesk({ deviceId: testId, dependencies });
  assert.equal(service.deviceId, testId);
  assert.throws(() => { service.deviceId = desktopId; }, TypeError);
  assert.equal(state.preflightConnects, 0);
  assert.deepEqual(state.sent.slice(0, 2).map((message) => message.type), ['auth', 'device']);
  assert.equal(state.sent[1].id, testId);
  const before = state.sent.length;
  await assert.rejects(service.request({ type: 'message.send', sessionId, text: 'test' }), { code: 'identity_mismatch' });
  service.sessions.set(sessionId, { id: sessionId, device: { id: testId } });
  await assert.rejects(service.request({ type: 'message.send', sessionId, text: 'test' }), { code: 'identity_mismatch' });
  await assert.rejects(service.request({ type: 'account.logout' }), { code: 'identity_mismatch' });
  assert.throws(() => service.send({ type: 'terminal.input', sessionId, data: 'x' }), { code: 'identity_mismatch' });
  assert.equal(state.sent.length, before);
  state.socket.receive({ type: 'session.updated', session: { id: 'own', device: { id: testId } } });
  assert.equal((await service.request({ type: 'session.subscribe', sessionId: 'own' })).ok, true);
  await service.close();
});

test('preflight refuses an active run on this device before creating a tunnel', async () => {
  const { state, dependencies } = harness({ preflightSessions: [{ id: sessionId, device: { id: desktopId }, activeRun: {} }] });
  const target = 'wss://127.0.0.1:29123/ws';
  dependencies.readConfig = async () => ({ servers: [{ ...server(), url: target }] });
  await assert.rejects(connectCCDesk({ dependencies }), { code: 'device_busy' });
  assert.equal(state.calls.includes('bridge'), false);
  assert.equal(state.preflightConnects, 1);
  assert.equal(state.preflightTarget, target);
  assert.deepEqual(state.preflightConfig, { fingerprint });
  assert.equal(state.preflightRoute, 'DIRECT');
  assert.equal(state.pinCheckedBeforeAuth, true);
  assert.equal(state.preflightClosed, 1);
  assert.deepEqual(state.preflightSent.map((message) => [message.type, message.tunnel]), [['auth', false]]);
});

test('preflight ignores active runs on other identified devices', async () => {
  const { state, dependencies } = harness({ preflightSessions: [{ id: sessionId, device: { id: testId }, activeRun: {} }] });
  const service = await connectCCDesk({ dependencies });
  assert.equal(state.preflightConnects, 1);
  assert.equal(state.calls.includes('bridge'), true);
  await service.close();
});

test('preflight never sends credentials on a certificate mismatch', async () => {
  const { state, dependencies } = harness({ pinMatches: false });
  const target = 'wss://127.0.0.1:29123/ws';
  dependencies.readConfig = async () => ({ servers: [{ ...server(), url: target }] });
  await assert.rejects(connectCCDesk({ dependencies }), { code: 'certificate_mismatch' });
  assert.equal(state.preflightConnects, 1);
  assert.equal(state.preflightTarget, target);
  assert.deepEqual(state.preflightSent, []);
  assert.equal(state.preflightClosed, 1);
  assert.equal(state.calls.includes('bridge'), false);
});

test('preflight rejects unknown active-device identity, auth failure and version mismatch without leaking credentials', async () => {
  for (const [options, expected] of [
    [{ preflightSessions: [{ id: sessionId, activeRun: {} }] }, 'identity_mismatch'],
    [{ preflightSessions: [{ id: sessionId, device: { id: desktopId } }] }, 'identity_mismatch'],
    [{ preflightFailure: { code: 'unauthorized', message: token } }, 'unauthorized'],
    [{ preflightVersion: '0.3.8' }, 'version_mismatch'],
  ]) {
    const { state, dependencies } = harness(options);
    await assert.rejects(connectCCDesk({ dependencies }), (error) => error.code === expected && !error.stack.includes(token));
    assert.equal(state.preflightConnects, 1);
    assert.equal(state.preflightClosed, 1);
    assert.equal(state.calls.includes('bridge'), false);
    assert.deepEqual(state.preflightSent.map((message) => message.type), ['auth']);
  }
});

test('rejects a test identity already used by a connected device or saved session before registering it', async () => {
  for (const conflict of [
    { devices: [{ id: testId, name: 'other', ready: true }] },
    { sessions: [{ id: sessionId, device: { id: testId } }] },
  ]) {
    const { state, dependencies } = harness({ isolated: true, ...conflict });
    await assert.rejects(connectCCDesk({ deviceId: testId, dependencies }), { code: 'identity_mismatch' });
    assert.equal(state.sent.some((message) => message.type === 'device'), false);
    assert.equal(state.closed, 1);
  }
});

test('channel waits for readiness and close rejects pending requests without sending leave', async () => {
  const { state, dependencies } = harness({ respond: false });
  const service = await connectCCDesk({ dependencies });
  state.socket.receive({ type: 'devices', devices: [{ id: desktopId, ready: false }] });
  const waiting = service.channel(100);
  state.socket.receive({ type: 'devices', devices: [{ id: desktopId, ready: true }] });
  await waiting;
  state.socket.receive({ type: 'devices', devices: [] });
  await assert.rejects(service.channel(5), { code: 'identity_mismatch' });
  const pending = service.request({ type: 'usage.summary' });
  const rejected = assert.rejects(pending, /连接已关闭/);
  await service.close();
  await rejected;
  await assert.rejects(service.request({ type: 'usage.summary' }), /连接已关闭/);
  assert.throws(() => service.send({ type: 'terminal.input' }), /连接已关闭/);
  await service.close();
  assert.equal(state.closed, 1);
  assert.equal(state.sent.some((message) => message.type === 'leave'), false);
});

test('never returns or prints a token through connection or request errors', async () => {
  const { state, dependencies } = harness({ respond: false });
  const service = await connectCCDesk({ dependencies });
  const messages = [];
  service.on('message', (message) => messages.push(message));
  state.socket.receive({ type: 'connection.error', code: token, message: token });
  const pending = service.request({ type: 'usage.summary' });
  const requestId = state.sent.at(-1).requestId;
  state.socket.receive({ type: 'response', requestId, ok: false, code: token, message: token });
  let rejected;
  try { await pending; } catch (error) { rejected = error; }
  assert.equal(rejected.code, 'request_failed');
  assert.equal([inspect(service), JSON.stringify(service), inspect(messages), rejected.stack].join('\n').includes(token), false);
  await service.close();
  const bad = harness();
  bad.dependencies.reveal = async () => { throw new Error(token); };
  await assert.rejects(connectCCDesk({ dependencies: bad.dependencies }), (error) => !error.stack.includes(token));
  assert.equal(bad.state.calls.includes('bridge'), false);
});

test('rejects an unexpected server version and closes its bridge', async () => {
  const { state, dependencies } = harness({ version: '0.3.8' });
  await assert.rejects(connectCCDesk({ dependencies }), { code: 'version_mismatch' });
  assert.equal(state.closed, 1);
});

test('reports a certificate mismatch without exposing the bridge error text', async () => {
  const { state, dependencies } = harness({ connectionFailure: { code: 'client_failed', message: `服务证书指纹不匹配 ${token}` } });
  await assert.rejects(connectCCDesk({ dependencies }), (error) => error.code === 'certificate_mismatch' && !error.stack.includes(token));
  assert.equal(state.closed, 1);
});

test('bridge cleanup failure is reported safely, including after unexpected disconnect', async () => {
  const isCleanupError = (error) => error.code === 'cleanup_failed' && !error.stack.includes(token);
  for (const disconnected of [false, true]) {
    const { state, dependencies } = harness({ cleanupFails: true });
    const service = await connectCCDesk({ dependencies });
    if (disconnected) {
      state.socket.terminate();
      await service.closed;
    }
    await assert.rejects(service.close(), isCleanupError);
    await assert.rejects(service.close(), isCleanupError);
    assert.equal(state.closed, 1);
  }
  for (const options of [{ version: '0.3.8' }, { earlyClose: true }]) {
    const { state, dependencies } = harness({ ...options, cleanupFails: true });
    await assert.rejects(connectCCDesk({ dependencies }), isCleanupError);
    assert.equal(state.closed, 1);
  }
});

test('reports cleanup failure when the authentication handshake also fails', async () => {
  const { state, dependencies } = harness({
    connectionFailure: { code: 'unauthorized', message: token }, cleanupFails: true,
  });
  await assert.rejects(connectCCDesk({ dependencies }), (error) => error.code === 'cleanup_failed' && !error.stack.includes(token));
  assert.equal(state.closed, 1);
});

test('loads the declared ws dependency without reading the installed application', async (t) => {
  const previous = process.env.LOCALAPPDATA;
  const local = 'C:\\test-local';
  let revealCalled = false;
  process.env.LOCALAPPDATA = local;
  const read = t.mock.method(fsPromises, 'readFile', async (file) => {
    assert.equal(file, join(local, 'Programs', 'CC Desk Tunnel', 'resources', 'app.asar', 'package.json'));
    return JSON.stringify({ version: '0.3.9' });
  });
  const fakeModule = 'data:text/javascript,' + encodeURIComponent(
    'export function openProxyBridge() {} export function connectService() {} export function certificateMatches() {}',
  );
  const toURL = t.mock.method(urlBuiltin, 'pathToFileURL', () => new URL(fakeModule));
  syncBuiltinESMExports();
  try {
    const { dependencies } = harness();
    delete dependencies.loadRuntime;
    dependencies.reveal = async () => { revealCalled = true; throw new Error(token); };
    await assert.rejects(connectCCDesk({ dependencies }), { code: 'unauthorized' });
    assert.equal(revealCalled, true);
  } finally {
    read.mock.restore();
    toURL.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});

test('DPAPI invokes only the absolute system PowerShell path, with the credential on stdin', async (t) => {
  const previous = process.env.SystemRoot;
  const calls = [];
  process.env.SystemRoot = 'C:\\Windows';
  const exec = t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    calls.push({ file, args, options });
    return Buffer.from(token).toString('base64');
  });
  syncBuiltinESMExports();
  try {
    const { dependencies } = harness();
    delete dependencies.reveal;
    const service = await connectCCDesk({ dependencies });
    assert.equal(calls[0].file, join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.equal(calls[0].options.input, server().token.data);
    assert.equal(calls[0].args.join(' ').includes(token), false);
    await service.close();
    process.env.SystemRoot = 'relative';
    const invalid = harness();
    delete invalid.dependencies.reveal;
    await assert.rejects(connectCCDesk({ dependencies: invalid.dependencies }), { code: 'unauthorized' });
    assert.equal(calls.length, 1);
    assert.equal(invalid.state.calls.includes('bridge'), false);
  } finally {
    exec.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  }
});

test('reads only standard APPDATA configuration and reports missing or unreadable files', async (t) => {
  const oldRoaming = process.env.APPDATA;
  const oldLocal = process.env.LOCALAPPDATA;
  const roaming = 'C:\\test-standard-roaming';
  const reads = [];
  let configError;
  process.env.APPDATA = roaming;
  process.env.LOCALAPPDATA = 'C:\\test-local';
  const read = t.mock.method(fsPromises, 'readFile', async (file) => {
    reads.push(file);
    if (file === join(roaming, 'ccdt', 'config.json')) {
      if (configError === 'invalid_json') return '{';
      if (configError) throw Object.assign(new Error('not available'), { code: configError });
      return JSON.stringify({ servers: [server()] });
    }
    if (file === join(roaming, 'CC Desk Tunnel', 'settings.json')) return JSON.stringify({ deviceId: desktopId });
    throw new Error('unexpected read');
  });
  syncBuiltinESMExports();
  try {
    const first = harness();
    delete first.dependencies.readConfig;
    delete first.dependencies.readDeviceId;
    const service = await connectCCDesk({ dependencies: first.dependencies });
    assert.equal(service.deviceId, desktopId);
    assert.deepEqual(reads, [
      join(roaming, 'ccdt', 'config.json'),
      join(roaming, 'CC Desk Tunnel', 'settings.json'),
    ]);
    await service.close();
    for (const [error, expected] of [
      ['ENOENT', 'config_not_found'],
      ['EACCES', 'config_permission_denied'],
      ['EIO', 'config_io_error'],
      ['invalid_json', 'config_invalid_json'],
    ]) {
      reads.length = 0;
      configError = error;
      const next = harness();
      delete next.dependencies.readConfig;
      delete next.dependencies.readDeviceId;
      await assert.rejects(connectCCDesk({ dependencies: next.dependencies }), { code: expected });
      assert.deepEqual(reads, [join(roaming, 'ccdt', 'config.json')]);
      assert.deepEqual(next.state.calls, []);
    }
    delete process.env.APPDATA;
    reads.length = 0;
    const missing = harness();
    delete missing.dependencies.readConfig;
    await assert.rejects(connectCCDesk({ dependencies: missing.dependencies }), { code: 'config_appdata_missing' });
    assert.deepEqual(reads, []);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
    if (oldRoaming === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldRoaming;
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocal;
  }
});
