# Paseo CC Desk provider candidate

This is an unfinished public candidate for a Windows Paseo provider connecting to the CC Desk Tunnel 0.3.9 local loopback WSS service. See [OVERVIEW.md](OVERVIEW.md) for setup, data access, the required network preflight and feature limits. Real Windows file read/write and end-to-end acceptance remain outstanding.

Before connecting and before each message is sent, a trusted PowerShell script named by the daemon's CCDESK_PREFLIGHT_SCRIPT environment variable must perform the operator's network checks and return a successful JSON response such as {"allow": true}. The plugin does not independently verify the network exit. It also waits for the CC Desk device's SSH execution channel to report ready. Missing configuration, errors, timeouts and unrecognized results block the operation.

The service loads private CC Desk bridge modules from %LOCALAPPDATA%\Programs\CC Desk Tunnel\resources\app.asar. These are not a stable public API; a CC Desk upgrade may break the integration. The ws dependency comes from this plugin's own package.

The pre-connection busy check is a snapshot and is not atomic with registration of a tunnel for the same device. A task started concurrently by another CC Desk client can still cause interference. Keep other clients idle while using this candidate.

Development checks use the officially published Paseo SDK and mocked service/preflight inputs. They do not connect to CC Desk or execute a preflight script. After installing development dependencies with npm ci --ignore-scripts, run npm test and npm run typecheck.

The plugin manifest's build installs the locked production dependency with npm ci --omit=dev --ignore-scripts. Do not commit real host addresses, local user paths, credentials, private session data or unredacted logs.
