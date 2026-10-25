# dsh-web-mcp

A DeepSeek Harness (DSH) plugin that exposes the live harness tool registry over authenticated Model Context Protocol (MCP) Streamable HTTP. MCP clients can use the same guarded tool execution pipeline as the harness. The upstream project's optional DeepSeek web subagent integration is retained under `integrations/dsh-subagent-deepseek-web/`.

> **Release candidate:** 0.2.1-rc.2 (target harness version). The upstream components were documented as verified against DSH 0.1.0-rc.6. This port does not claim compatibility with 0.2.1-rc.2 until the target harness's plugin loader and tests have been run against that exact release.

## Features

- Serves DSH tools through an MCP Streamable HTTP endpoint.
- Uses the harness tool execution pipeline, including its guards and output validation.
- Bearer-token authentication, host/origin checks, request-size limits, and tool-call timeouts.
- Optional DeepSeek web subagent provider integration for delegating tasks to a browser session.
- Node.js ES modules; the core plugin declares no npm runtime dependencies.

## Requirements

- Node.js 20 or newer.
- DeepSeek Harness installed and runnable.
- An MCP client that supports Streamable HTTP, if connecting an external client.
- For browser-based delegation, the compatible DeepSeek++ delegate extension and a configured browser session.

## Install the core plugin

1. Clone this repository:

   ```sh
   git clone https://github.com/mulqizamzam/dsh-web-mcp.git
   cd dsh-web-mcp
   ```

2. Add the plugin to your DSH web profile:

   ```sh
   dsh plugin --profile web add ./dsh-mcp-server
   ```

3. Generate a strong bearer token:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. Put the token in the plugin's profile configuration (see [Configuration](#configuration)). Never commit the real token. The checked-in patch template uses `CHANGE_ME` as a placeholder; replace it before starting a server.

5. Start DSH:

   ```sh
   dsh web
   ```

The default endpoint is `http://127.0.0.1:3080/mcp`.

## Configuration

The plugin's DSH bundle patch is in `cordis.patch.yml`. Configure the inserted `mcp-server` component in the DSH profile. Supported options in the upstream implementation:

| Setting | Default | Purpose |
| --- | --- | --- |
| `path` | `/mcp` | HTTP endpoint pathname |
| `token` | required | Bearer credential for every request |
| `agentPreset` | unset | Select the newest session on a named preset |
| `sessionId` | unset | Pin requests to one exact session |
| `allowedOrigins` | `[]` | Browser origins allowed to connect |
| `trustedHosts` | `[]` | Additional non-loopback `host:port` authorities |
| `maxRequestBytes` | `1048576` | Maximum request body size |
| `toolTimeoutMs` | `300000` | Timeout for one MCP tool call |

Prefer `agentPreset` when multiple sessions may be open. Session IDs are created per run. Do not expose the endpoint to untrusted networks: the token grants access to mounted tools, potentially including shell execution. Use a unique secret, restrict origins and trusted hosts, and keep the endpoint on loopback unless remote access is deliberately secured.

## Connect an MCP client

Configure the client with:

- **Transport:** `streamable_http`
- **URL:** `http://127.0.0.1:3080/mcp`
- **Authentication:** bearer token generated above

For the DeepSeek++ browser extension, add the endpoint in its MCP settings and grant host access to the local DSH origin when prompted.

## Optional: install the DeepSeek web subagent integration

The upstream subagent provider is retained at `integrations/dsh-subagent-deepseek-web/`. It delegates child tasks to a DeepSeek web conversation and returns the result to the parent harness agent. It requires the browser-side delegate and the MCP bridge to be configured.

From the repository root:

```sh
dsh plugin --profile web add ./integrations/dsh-subagent-deepseek-web
```

The model-facing tool row is configured in the chosen agent preset, not in the provider's host-plane patch:

```yaml
- id: tool-subagent-deepseek-web
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: deepseek-web
    toolName: subagent_deepseek_web
    enableRunInBackground: false
    maxDepth: provider-managed
```

Use `maxDepth: provider-managed` as shown: the upstream provider does not advertise a numeric depth-limit capability. See the integration's README for task queue behavior and settings.

## Development and verification

Core source files:

- `index.js` — plugin registration and HTTP endpoint.
- `protocol.js` — MCP protocol handling.
- `trust.js` — request trust checks.
- `verify-protocol.mjs` — protocol verification script.

Optional subagent source is under `integrations/dsh-subagent-deepseek-web/`.

Run the core protocol verification in an environment with the target DSH installation available. Set `DSH_CORDIS_ENTRY` to the installed Cordis module entry (a file URL or resolvable module specifier):

```sh
DSH_CORDIS_ENTRY=/absolute/path/to/cordis/lib/index.js node dsh-mcp-server/verify-protocol.mjs
```

Run the optional provider verification with `DSH_CORDIS_ENTRY=/absolute/path/to/cordis/lib/index.js node integrations/dsh-subagent-deepseek-web/verify-provider.mjs`; run the live verification only in an environment where its documented DSH/browser prerequisites are available. This repository was reconciled from upstream source; a successful local static review is not equivalent to a live integration test on DSH 0.2.1-rc.2.

## Troubleshooting

- **401/unauthorized:** confirm the client sends `Authorization: Bearer <token>` and the token matches the active DSH profile.
- **Origin rejected:** add only the exact browser origin to `allowedOrigins`; avoid wildcard trust.
- **Host rejected:** keep the service on loopback or explicitly configure a trusted `host:port` after reviewing the network exposure.
- **No active session / empty tool catalog:** select the intended `agentPreset` or exact `sessionId`; tool catalogs are scoped to an agent/session.
- **Tool call times out:** check the target tool's execution time and adjust `toolTimeoutMs` only as needed.
- **Subagent tool is unavailable:** verify the provider plugin is installed and the tool row is present in the selected agent preset.
- **Compatibility errors:** check the exact DSH version and plugin loader API. The source's documented baseline is older than the requested target.

## Security notes

The bearer token is highly privileged: a holder may be able to invoke any tool mounted in the selected harness session, including commands that modify or delete files. Keep credentials out of version control, logs, issue reports, and screenshots. Use least privilege and review all mounted tools before enabling external clients.

## License

Core plugin files retain the upstream MIT license. The optional browser delegate's upstream license and attribution requirements apply to that integration; see its license file and upstream project notices.
