import test from "node:test";
import assert from "node:assert/strict";
import { environmentGatePassed, readEnvironmentGate } from "../server/environment-gate.mjs";

const env = { CCDESK_PREFLIGHT_SCRIPT: "C:\\checks\\preflight.ps1", SystemRoot: "C:\\Windows" };

test("a JSON object must explicitly allow and the channel must be ready", () => {
  assert.equal(environmentGatePassed({ allow: true }, true), true);
  for (const report of [null, [], {}, { allow: false }, { allow: "true" }, true, "true"])
    assert.equal(environmentGatePassed(report, true), false);
  for (const ready of [false, undefined, null, 1, "true"])
    assert.equal(environmentGatePassed({ allow: true }, ready), false);
});

test("runs the configured absolute script using system PowerShell without a shell", async () => {
  let calls = 0;
  const result = await readEnvironmentGate({ env, platform: "win32", execute: async (file, args, options) => {
    calls++;
    assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(args, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", env.CCDESK_PREFLIGHT_SCRIPT,
    ]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 120000);
    assert.equal(options.maxBuffer, 262144);
    assert.equal(options.encoding, "utf8");
    return { stdout: '{"allow":true}' };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { allow: true });
});

test("rejects missing or invalid script paths and system roots before spawning", async () => {
  let calls = 0;
  const execute = async () => { calls++; return { stdout: '{"allow":true}' }; };
  for (const script of [undefined, "", "preflight.ps1", "C:preflight.ps1", "\\preflight.ps1",
    "C:\\checks\\preflight.cmd", "C:\\checks\\preflight.ps1\0"]) {
    await assert.rejects(readEnvironmentGate({ env: { ...env, CCDESK_PREFLIGHT_SCRIPT: script }, platform: "win32", execute }));
  }
  for (const systemRoot of [undefined, "Windows", "\\Windows"]) {
    await assert.rejects(readEnvironmentGate({ env: { ...env, SystemRoot: systemRoot }, platform: "win32", execute }));
  }
  await assert.rejects(readEnvironmentGate({ env, platform: "linux", execute }));
  assert.equal(calls, 0);
});

test("rejects a denied, malformed, failed or timed-out script without exposing its output", async () => {
  for (const stdout of ["null", "[]", "{}", '{"allow":false}', '{"allow":"true"}', "private test output"]) {
    await assert.rejects(readEnvironmentGate({ env, platform: "win32", execute: async () => ({ stdout }) }),
      { message: "CC Desk preflight failed or did not explicitly allow sending." });
  }
  for (const error of [new Error("private test output"), Object.assign(new Error("private test output"), { killed: true, code: "ETIMEDOUT" })]) {
    await assert.rejects(readEnvironmentGate({ env, platform: "win32", execute: async () => { throw error; } }),
      (failure) => failure.message === "CC Desk preflight failed or did not explicitly allow sending." && failure.cause === undefined);
  }
});
