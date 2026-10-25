# Release candidate status

Target requested: DeepSeek Harness 0.2.1-rc.2  
Plugin package version: 0.2.1-rc.2  
Source: https://github.com/lisycotana/dsh-deepseek-plugins

## Implemented in this port

- Preserved the MCP server entry point, protocol implementation, trust checks, DSH bundle patch, and protocol verification harness.
- Preserved the optional DeepSeek web subagent provider, task bridge, tool definitions, Skill, configuration patch, and verification scripts.
- Added beginner-oriented root documentation and a dedicated core-plugin README.
- Removed the absolute Windows user-profile path from the protocol verification script. The Cordis module entry is now supplied through `DSH_CORDIS_ENTRY`.

## Validation status

| Check | Status | Evidence / limitation |
| --- | --- | --- |
| Public GitHub repository | Pass | Repository is public and contains committed files. |
| Repository structure | Pass | Core plugin and optional integration are separated. |
| Package metadata | Partial | Package manifests are present; runtime compatibility is not established by metadata alone. |
| Secret review | Partial | No live bearer token was added; the configuration uses a placeholder. A full secret scanner was not run. |
| Static syntax checks | Not run | No repository execution environment was available in this workflow. |
| Protocol integration test | Not run | Requires the installed target DSH Cordis module; configure `DSH_CORDIS_ENTRY`. |
| DSH 0.2.1-rc.2 live compatibility | Not verified | Upstream documentation cites DSH 0.1.0-rc.6, and the requested target tag was not found in the checked release/tag endpoint. |
| Browser delegate end-to-end test | Not run | Requires the matching browser extension and a live DeepSeek web session. |
| GitHub repository Description field | Not updated | The available GitHub integration supports repository reads and file commits, but not repository metadata editing. |
| Release tag / GitHub Release | Not created | Release/tag creation is not exposed by the available GitHub actions. |

## Before calling this release-ready

1. Run static syntax checks with Node.js 20 or newer.
2. Run `DSH_CORDIS_ENTRY=/path/to/cordis/lib/index.js node dsh-mcp-server/verify-protocol.mjs` in the intended DSH installation.
3. Install both plugins into an isolated DSH 0.2.1-rc.2 profile and verify mounting, tool discovery, auth rejection, and tool dispatch.
4. Test the browser delegate's claim/settle lifecycle end to end.
5. Run secret scanning and inspect the final package contents.
6. Set the GitHub repository description to: **“Authenticated Streamable HTTP MCP server for DeepSeek Harness, with optional DeepSeek web subagent delegation.”**
7. Only then tag and publish the release candidate.

This status file deliberately distinguishes source porting from verified runtime compatibility.
