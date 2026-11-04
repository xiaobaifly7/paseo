import { execFile } from "node:child_process";
import { win32 as path } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const absoluteWindowsPath = (value) =>
  typeof value === "string" && !value.includes("\0") &&
  /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) && path.isAbsolute(value);

export function preflightApproved(report) {
  return report !== null && typeof report === "object" && !Array.isArray(report) && report.allow === true;
}

export function environmentGatePassed(report, channelReady) {
  return channelReady === true && preflightApproved(report);
}

export async function readEnvironmentGate({ execute = executeFile, env = process.env, platform = process.platform } = {}) {
  const script = env.CCDESK_PREFLIGHT_SCRIPT;
  const systemRoot = env.SystemRoot;
  if (platform !== "win32" || !absoluteWindowsPath(script) || path.extname(script).toLowerCase() !== ".ps1" ||
      !absoluteWindowsPath(systemRoot) || !/^[a-z]:[\\/]/i.test(systemRoot)) {
    throw new Error("CC Desk preflight requires a trusted absolute Windows .ps1 path and system PowerShell.");
  }
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const { stdout } = await execute(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ], { windowsHide: true, shell: false, timeout: 120000, maxBuffer: 262144, encoding: "utf8" });
    const report = JSON.parse(stdout);
    if (!environmentGatePassed(report, true)) throw new Error("preflight denied");
    return report;
  } catch {
    throw new Error("CC Desk preflight failed or did not explicitly allow sending.");
  }
}
