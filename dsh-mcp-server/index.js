/**
 * dsh-mcp-server: exposes the DeepSeek Harness tool registry to MCP clients
 * over HTTP, so a browser-side chat (DeepSeek web with the DeepSeek++
 * extension, or any MCP client) can drive the local machine through the
 * harness rather than through a second, parallel tool implementation.
 *
 * The harness ships an MCP *client* that consumes external servers. This is the
 * other direction, and it is not a duplicate of the ACP bridge: ACP exposes the
 * harness as a conversational agent, whereas this exposes it as a tool
 * provider. A client that already owns the conversation needs the latter.
 *
 * Transport is the MCP Streamable HTTP shape restricted to what a tool-only
 * server needs: a single endpoint answering POST with `application/json`. No
 * SSE stream is opened — this server never initiates requests toward the
 * client, so the stream would carry nothing for its lifetime. Clients dispatch
 * on the response content type, so one that advertises `text/event-stream`
 * still interoperates.
 *
 * @module dsh-mcp-server
 */

import { randomUUID } from 'node:crypto'
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  isJsonRpcMessage,
  isNotification,
  negotiateProtocolVersion,
  rpcError,
  rpcResult,
  toMcpCallResult,
  toMcpTools,
} from './protocol.js'
import { admitRequest, corsHeaders } from './trust.js'

export const name = 'mcp-server'

/** Server identity reported during `initialize`. */
const SERVER_INFO = { name: 'deepseek-harness', version: '0.1.0' }

/** Defaults for every optional config field. */
const DEFAULTS = {
  path: '/mcp',
  allowedOrigins: [],
  trustedHosts: [],
  maxRequestBytes: 1_048_576,
  toolTimeoutMs: 300_000,
  sessionId: undefined,
}

/**
 * Resolve the agent whose tool scope this endpoint exposes.
 *
 * The tool registry is scoped, and in the Web composition every `tool-*` row is
 * mounted per agent preset rather than globally — an unscoped read returns an
 * empty catalog. The scope key is the Agent itself, so serving a real catalog
 * means holding a real agent.
 *
 * Selection narrows in the order a deployment can actually rely on. A
 * `sessionId` pins one conversation, but ids are minted per run, so it only
 * suits a one-off. An `agentPreset` is stable across restarts and is the
 * practical choice: it names the *kind* of session this endpoint serves. With
 * neither, the newest live root wins — several sessions open at once is the
 * normal state of a running harness, and the newest is the one a user just
 * opened for this purpose.
 * @param agents - the `ctx.agents` registry.
 * @param sessionId - the configured session id, when one was set.
 * @param agentPreset - the configured preset name, when one was set.
 * @returns `{ agent }`, or `{ error }` naming why no agent could be resolved.
 */
function resolveAgent(agents, sessionId, agentPreset) {
  if (sessionId !== undefined) {
    const agent = agents.get(sessionId)
    if (agent === undefined) {
      return { error: `No live agent for the configured sessionId ${JSON.stringify(sessionId)}.` }
    }
    return { agent }
  }
  const roots = agents.roots()
  if (roots.length === 0) {
    return { error: 'No live agent. Open a session in the harness first.' }
  }
  if (agentPreset !== undefined) {
    // Newest-first: a user reopening the delegate session expects that one, not
    // an older session left over from a previous task.
    const matching = roots.filter((agent) => agent.session?.header?.agentPreset === agentPreset)
    if (matching.length === 0) {
      const seen = [...new Set(roots.map((a) => a.session?.header?.agentPreset ?? '?'))].join(', ')
      return { error: `No live session on preset ${JSON.stringify(agentPreset)} (open: ${seen}).` }
    }
    return { agent: matching[matching.length - 1] }
  }
  return { agent: roots[roots.length - 1] }
}

/**
 * Validate and default the plugin config.
 *
 * Misconfiguration fails at load rather than on the first request: a missing or
 * placeholder token would otherwise leave an endpoint that rejects everything,
 * and a typo'd path would leave one that answers nothing, both of which read as
 * a client problem from the outside.
 * @param config - the raw config from the cordis patch.
 * @returns the resolved config with defaults applied.
 * @throws when a field is missing, mistyped, or a known placeholder.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const token = raw.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('dsh-mcp-server: `token` is required — set a long random string in the plugin config.')
  }
  if (token === 'CHANGE_ME') {
    throw new Error('dsh-mcp-server: `token` is still the placeholder. Generate one: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"')
  }
  const path = raw.path ?? DEFAULTS.path
  if (typeof path !== 'string' || !path.startsWith('/') || path.endsWith('/')) {
    throw new Error(`dsh-mcp-server: \`path\` must be an absolute pathname with no trailing slash, got ${JSON.stringify(path)}`)
  }
  if (raw.sessionId !== undefined && typeof raw.sessionId !== 'string') {
    throw new Error('dsh-mcp-server: `sessionId` must be a string when set.')
  }
  if (raw.agentPreset !== undefined && typeof raw.agentPreset !== 'string') {
    throw new Error('dsh-mcp-server: `agentPreset` must be a string when set.')
  }
  return {
    path,
    token,
    sessionId: raw.sessionId,
    agentPreset: raw.agentPreset,
    allowedOrigins: stringArray(raw.allowedOrigins, DEFAULTS.allowedOrigins, 'allowedOrigins'),
    trustedHosts: stringArray(raw.trustedHosts, DEFAULTS.trustedHosts, 'trustedHosts'),
    maxRequestBytes: positiveInteger(raw.maxRequestBytes, DEFAULTS.maxRequestBytes, 'maxRequestBytes'),
    toolTimeoutMs: positiveInteger(raw.toolTimeoutMs, DEFAULTS.toolTimeoutMs, 'toolTimeoutMs'),
  }
}

/**
 * Validate an optional string-array config field.
 * @param value - the configured value.
 * @param fallback - the value used when unset.
 * @param field - the field name, for the error message.
 * @returns the validated array.
 * @throws when the value is present but not an array of strings.
 */
function stringArray(value, fallback, field) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`dsh-mcp-server: \`${field}\` must be an array of strings.`)
  }
  return value
}

/**
 * Validate an optional positive-integer config field.
 * @param value - the configured value.
 * @param fallback - the value used when unset.
 * @param field - the field name, for the error message.
 * @returns the validated number.
 * @throws when the value is present but not a positive integer.
 */
function positiveInteger(value, fallback, field) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-mcp-server: \`${field}\` must be a positive integer.`)
  }
  return value
}

/**
 * Read a request body with a hard byte ceiling.
 * @param req - the incoming request.
 * @param maxBytes - the largest body accepted.
 * @returns the decoded UTF-8 body.
 * @throws when the body exceeds `maxBytes`.
 */
async function readBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Request body too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param res - the server response.
 * @param status - the HTTP status code.
 * @param body - the value to serialize, or undefined for an empty body.
 * @param extraHeaders - headers merged into the response.
 */
function sendJson(res, status, body, extraHeaders) {
  const headers = { ...extraHeaders }
  if (body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  const payload = JSON.stringify(body)
  headers['content-type'] = 'application/json'
  headers['content-length'] = String(Buffer.byteLength(payload))
  res.writeHead(status, headers)
  res.end(payload)
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /**
   * Sessions issued at `initialize`, keyed by id.
   *
   * A session holds only the negotiated revision: this server keeps no
   * per-client tool state, and the harness registry is process-global. The map
   * exists so a client presenting `Mcp-Session-Id` gets the protocol's
   * 404-means-reinitialize behavior instead of silent acceptance.
   */
  const sessions = new Map()

  ctx.inject(['tools', 'webServer', 'agents'], (scoped) => {
    /**
     * Answer one JSON-RPC message.
     * @param message - a validated JSON-RPC message.
     * @returns `{ response, sessionId? }`; `response` is undefined for a notification.
     */
    async function dispatch(message) {
      const { method, id } = message

      if (method === 'initialize') {
        const params = message.params ?? {}
        const protocolVersion = negotiateProtocolVersion(params.protocolVersion)
        const sessionId = randomUUID()
        sessions.set(sessionId, { protocolVersion })
        return {
          response: rpcResult(id, {
            protocolVersion,
            // Only tools are advertised. `listChanged` stays false: this server
            // holds no channel to the client, so it cannot deliver the
            // notification it would be promising.
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          }),
          sessionId,
        }
      }

      if (method === 'notifications/initialized') return { response: undefined }
      if (method === 'ping') return { response: rpcResult(id, {}) }

      if (method === 'tools/list') {
        // The agent is resolved per request rather than pinned at initialize:
        // a client may connect before any session exists, and re-resolving lets
        // it recover by listing again instead of reconnecting.
        const resolution = resolveAgent(scoped.agents, config.sessionId, config.agentPreset)
        if (resolution.error !== undefined) {
          return { response: rpcError(id, RPC_INTERNAL_ERROR, resolution.error) }
        }
        return { response: rpcResult(id, { tools: toMcpTools(scoped.tools.schemas(resolution.agent)) }) }
      }

      if (method === 'tools/call') {
        const params = message.params ?? {}
        if (typeof params.name !== 'string') {
          return { response: rpcError(id, RPC_INVALID_PARAMS, 'tools/call requires a string `name`.') }
        }
        const resolution = resolveAgent(scoped.agents, config.sessionId, config.agentPreset)
        if (resolution.error !== undefined) {
          return { response: rpcError(id, RPC_INTERNAL_ERROR, resolution.error) }
        }
        return { response: await callTool(id, params, resolution.agent) }
      }

      return { response: rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`) }
    }

    /**
     * Execute one tool through the harness pipeline.
     *
     * Dispatch goes through `tools.execute()` rather than a definition's own
     * `execute`, so identity protection, the pre/post policy waterfalls,
     * registered guards, and output validation all run.
     *
     * A failing tool is a JSON-RPC *success* carrying `isError: true`, per MCP:
     * the call reached the tool, and the model is meant to read and react to
     * the failure text. A JSON-RPC error is reserved for the call not reaching
     * a tool at all.
     * @param id - the JSON-RPC request id.
     * @param params - the validated `tools/call` params.
     * @param agent - the agent whose scope and session the call runs under.
     * @returns the JSON-RPC response envelope.
     */
    async function callTool(id, params, agent) {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort(new Error(`Tool timed out after ${String(config.toolTimeoutMs)}ms.`))
      }, config.toolTimeoutMs)
      try {
        const result = await scoped.tools.execute({
          callId: `mcp-${randomUUID()}`,
          name: params.name,
          arguments: params.arguments ?? {},
          // Carrying the agent gives the call the scoped catalog, its session
          // for tools that write one, and an open turn for approval requests.
          agent,
          signal: controller.signal,
        })
        return rpcResult(id, toMcpCallResult(result))
      } catch (error) {
        // Reached only when the registry rejects the call itself (unknown tool,
        // non-serializable arguments); a tool's own failure returns a result.
        return rpcError(id, RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Handle one HTTP request on the MCP endpoint.
     * @param req - the incoming request.
     * @param res - the server response.
     */
    async function handle(req, res) {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      const cors = corsHeaders(origin, config)

      // Preflight carries no credentials by definition, so it is answered
      // before the admission check rather than refused by it.
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, undefined, cors)
        return
      }

      const admission = admitRequest(req, config)
      if (!admission.ok) {
        sendJson(res, admission.status, { error: admission.message }, cors)
        return
      }

      // Released explicitly rather than left to expire, so a client that
      // reconnects repeatedly does not accumulate entries.
      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id']
        if (typeof sessionId === 'string') sessions.delete(sessionId)
        sendJson(res, 204, undefined, cors)
        return
      }

      // A tool-only server initiates nothing, so the server-to-client stream
      // would stay empty for its lifetime. 405 is the protocol's answer for a
      // server that does not offer it.
      if (req.method === 'GET') {
        sendJson(res, 405, { error: 'This server does not offer a server-to-client stream.' }, cors)
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed.' }, cors)
        return
      }

      let raw
      try {
        raw = await readBody(req, config.maxRequestBytes)
      } catch (error) {
        sendJson(res, 413, { error: error instanceof Error ? error.message : String(error) }, cors)
        return
      }

      let message
      try {
        message = JSON.parse(raw)
      } catch {
        sendJson(res, 400, rpcError(null, RPC_PARSE_ERROR, 'Request body was not valid JSON.'), cors)
        return
      }

      if (Array.isArray(message)) {
        sendJson(res, 400, rpcError(null, RPC_INVALID_REQUEST, 'Batched requests are not supported.'), cors)
        return
      }
      if (!isJsonRpcMessage(message)) {
        sendJson(res, 400, rpcError(null, RPC_INVALID_REQUEST, 'Body was not a JSON-RPC 2.0 message.'), cors)
        return
      }

      const requestedSession = req.headers['mcp-session-id']
      if (typeof requestedSession === 'string' && !sessions.has(requestedSession) && message.method !== 'initialize') {
        // 404 is what tells a client to re-run `initialize` rather than retry.
        sendJson(res, 404, rpcError(message.id ?? null, RPC_INVALID_REQUEST, 'Unknown session.'), cors)
        return
      }

      let outcome
      try {
        outcome = await dispatch(message)
      } catch (error) {
        const body = rpcError(
          message.id ?? null,
          RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        )
        sendJson(res, 200, body, cors)
        return
      }

      const headers = { ...cors }
      if (outcome.sessionId !== undefined) headers['mcp-session-id'] = outcome.sessionId

      if (outcome.response === undefined || isNotification(message)) {
        sendJson(res, 202, undefined, headers)
        return
      }
      sendJson(res, 200, outcome.response, headers)
    }

    scoped.effect(() =>
      scoped.webServer.register({
        kind: 'exact',
        path: config.path,
        handler: (req, res) => {
          handle(req, res).catch((error) => {
            if (res.headersSent) {
              res.end()
              return
            }
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }, {})
          })
        },
      }),
    )

    scoped.effect(() => () => sessions.clear())

    const served = config.sessionId !== undefined
      ? `session ${config.sessionId}`
      : config.agentPreset !== undefined
        ? `the newest session on preset ${config.agentPreset}`
        : 'the newest live session'
    scoped.logger?.info?.(`dsh-mcp-server: MCP endpoint on ${config.path}; tools are served from ${served}`)
  })
}
