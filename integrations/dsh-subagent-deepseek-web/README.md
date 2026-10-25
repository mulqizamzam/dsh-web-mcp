# Optional DSH DeepSeek web subagent

This provider delegates child tasks to a DeepSeek web conversation via the task bridge and returns the result to the parent agent. It is an optional integration, separate from the core `dsh-web-mcp` MCP server.

Install after configuring the core plugin:

```sh
dsh plugin --profile web add ./integrations/dsh-subagent-deepseek-web
```

The model-facing tool row belongs in the selected agent preset:

```yaml
- id: tool-subagent-deepseek-web
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: deepseek-web
    toolName: subagent_deepseek_web
    enableRunInBackground: false
    maxDepth: provider-managed
```

This integration requires the browser-side delegate and a running core MCP endpoint. Its source was documented against DSH 0.1.0-rc.6; verify plugin loading and provider behavior against your exact target runtime before production use. See the [root README](../../README.md).
