# CC Desk provider candidate

This development candidate connects Paseo to CC Desk Tunnel on Windows using its local loopback WSS service and SSH execution channel. It targets Paseo 0.15.0 or later and CC Desk Tunnel 0.3.9. Real Windows file reads and writes through this candidate have not been accepted, and no end-to-end acceptance is claimed.

## Required network preflight

Set CCDESK_PREFLIGHT_SCRIPT in the environment inherited by the Paseo daemon and plugin process to a trusted, fully qualified Windows .ps1 file. The script must perform the network and exit checks required by the operator, exit successfully, and emit a JSON object such as {"allow": true} on standard output. It runs before connecting and before every message through the absolute system Windows PowerShell executable, passing the script path as an argument with a process-scoped execution-policy override. The plugin also waits for CC Desk to report its device SSH execution channel ready.

The plugin does not itself verify the network exit or guarantee where model traffic goes. A missing or invalid script path, failed script, timeout, malformed JSON, or any response without boolean allow: true blocks the message. The timeout is 120 seconds. Agent-provided launch or session environment cannot select the script. The script is trusted code and runs with the daemon user's permissions.

## Data access

The service component uses the current Windows user's CC Desk configuration and credentials to authenticate to the local service and access its sessions. Session identifiers, device identifiers and workspace paths can be stored in Paseo session persistence. CC Desk and its execution environment determine where messages and model requests go. Paseo plugins run with the daemon user's access; review all plugin code and the chosen preflight script before use.

## Limits

- The service loads private bridge modules from the installed CC Desk Tunnel app at %LOCALAPPDATA%\Programs\CC Desk Tunnel\resources\app.asar. These modules are not a stable public API; CC Desk upgrades can break compatibility. The ws dependency is provided by this plugin.
- The busy-device check before connecting is a snapshot. It is not atomic with registering a tunnel for the same device. If another CC Desk client starts work at the same time, interference cannot be ruled out. Keep other clients idle while using this candidate.
- Model and effort selection from Paseo are not supported; the native CC Desk session controls them.
- Paseo's built-in MCP server is not passed to CC Desk. A recognized loopback Paseo MCP entry is omitted with a visible warning; other MCP server configurations are rejected. The plugin does not change CC Desk's own MCP configuration.
- Only text prompts are supported. Existing session ownership and approval-mode changes have limitations across plugin restarts.
- This is a candidate, not a claim of real Windows file read/write, full approval, or end-to-end acceptance.
