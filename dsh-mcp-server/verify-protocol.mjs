/**
 * Verifies the MCP endpoint against a real HTTP server and a stubbed tool
 * registry: full handshake, auth refusals, and a tool call end to end.
 *
 * Run: node verify-protocol.mjs
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const BASE = 'file:///C:/Users/REISEN/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(`${BASE}/cordis/lib/index.js`)
const plugin = await import('./index.js')

const TOKEN = randomBytes(16).toString('hex')
const ORIGIN = 'chrome-extension://kdmpkkahkhdmdhfkdihkopikgcocbpbf'

// Stub the two injected services. `webServer` captures the route; `tools`
// answers a fixed catalog and echoes call arguments.
let route
const webServerStub = {
  name: 'webServerStub',
  apply(ctx) {
    return ctx.provide('webServer', {
      host: '127.0.0.1',
      port: 0,
      register(entry) {
        route = entry
        return () => { route = undefined }
      },
    })
  },
}

// A scoped registry: an unscoped read is empty, exactly as the Web
// composition behaves, so a regression that drops the agent scope shows up as
// an empty catalog rather than passing silently.
const FAKE_AGENT = { id: 'agent-1', session: { header: { agentPreset: 'web-delegate' } } }
let lastExecuted
const toolsStub = {
  name: 'toolsStub',
  apply(ctx) {
    return ctx.provide('tools', {
      schemas: (scope) => scope === FAKE_AGENT
        ? [
            { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
            { name: 'no_params', description: 'Takes nothing.', parameters: undefined },
          ]
        : [],
      execute: async (exec) => {
        lastExecuted = exec
        if (exec.name === 'boom') throw new Error('Unknown tool: boom')
        if (exec.name === 'failing') return { isError: true, content: [{ type: 'text', text: 'tool said no' }] }
        return { isError: false, value: null, content: [{ type: 'text', text: `ran ${exec.name} with ${JSON.stringify(exec.arguments)}` }] }
      },
    })
  },
}

// Root agents are mutable so the suite can exercise the none/one/many cases.
// Each carries a preset header, which is how a deployment names the session it
// wants served.
const FAKE_AGENT_2 = { id: 'agent-2', session: { header: { agentPreset: 'standard' } } }
let rootAgents = [FAKE_AGENT]
const agentsStub = {
  name: 'agentsStub',
  apply(ctx) {
    return ctx.provide('agents', {
      roots: () => rootAgents,
      get: (id) => rootAgents.find((agent) => agent.id === id),
      list: () => rootAgents,
    })
  },
}

const ctx = new Context()
await ctx.plugin(webServerStub)
await ctx.plugin(toolsStub)
await ctx.plugin(agentsStub)
await ctx.plugin(plugin, { path: '/mcp', token: TOKEN, allowedOrigins: [ORIGIN] })

// ctx.inject() resolves once the injected services settle.
for (let attempt = 0; attempt < 50 && route === undefined; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
if (route === undefined) throw new Error('plugin registered no route')
console.log(`route: kind=${route.kind} path=${route.path}`)

console.log('\n[config validation]')
/**
 * Assert that a config is refused at load.
 * @param label - what is being checked.
 * @param config - the config under test.
 * @param expected - a substring the thrown message must contain.
 */
async function refuses(label, config, expected) {
  const probe = new Context()
  await probe.plugin(webServerStub)
  await probe.plugin(toolsStub)
  await probe.plugin(agentsStub)
  try {
    await probe.plugin(plugin, config)
    check(label, false, 'did not throw')
  } catch (error) {
    check(label, String(error.message).includes(expected), error.message)
  }
  await probe.stop?.()
}

await refuses('missing token refused', { token: undefined }, '`token` is required')
await refuses('placeholder token refused', { token: 'CHANGE_ME' }, 'still the placeholder')
await refuses('bad path refused', { token: TOKEN, path: 'mcp' }, '`path` must be an absolute pathname')
await refuses('trailing-slash path refused', { token: TOKEN, path: '/mcp/' }, '`path` must be an absolute pathname')
await refuses('bad allowedOrigins refused', { token: TOKEN, allowedOrigins: 'nope' }, '`allowedOrigins` must be an array')
await refuses('bad maxRequestBytes refused', { token: TOKEN, maxRequestBytes: 0 }, '`maxRequestBytes` must be a positive integer')

console.log('\n[trust unit]')
const { admitRequest } = await import('./trust.js')
/**
 * Build request-like headers for an admission check.
 * @param headers - the header map.
 * @returns a minimal request stand-in.
 */
const asReq = (headers) => ({ headers })
const policy = { token: TOKEN, allowedOrigins: [ORIGIN], trustedHosts: ['harness.internal', 'pinned.example:8443'] }
const auth = { authorization: `Bearer ${TOKEN}` }

check('loopback host admitted', admitRequest(asReq({ host: '127.0.0.1:3080', ...auth }), policy).ok)
check('foreign host refused', !admitRequest(asReq({ host: 'evil.example', ...auth }), policy).ok)
check('port-less trustedHosts entry matches any port', admitRequest(asReq({ host: 'harness.internal:9999', ...auth }), policy).ok)
check('pinned trustedHosts entry matches its port', admitRequest(asReq({ host: 'pinned.example:8443', ...auth }), policy).ok)
check('pinned trustedHosts entry rejects other port', !admitRequest(asReq({ host: 'pinned.example:1234', ...auth }), policy).ok)
check('same-authority origin admitted over https', admitRequest(asReq({ host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080', ...auth }), policy).ok)
check('opaque null origin refused', !admitRequest(asReq({ host: '127.0.0.1:3080', origin: 'null', ...auth }), policy).ok)
check('token length mismatch refused', !admitRequest(asReq({ host: '127.0.0.1', authorization: `Bearer ${TOKEN}x` }), policy).ok)

const server = createServer((req, res) => { route.handler(req, res) })
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}/mcp`

let failures = 0
/**
 * Assert one condition and record the outcome.
 * @param label - what is being checked.
 * @param condition - the assertion result.
 * @param detail - extra context printed on failure.
 */
function check(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); return }
  failures += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Send one MCP message.
 * @param body - the JSON-RPC message, or a raw string.
 * @param options - `token`, `origin`, `sessionId`, `method` overrides.
 * @returns status, headers, and parsed body.
 */
async function send(body, options = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const token = options.token === null ? undefined : (options.token ?? TOKEN)
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.sessionId !== undefined) headers['mcp-session-id'] = options.sessionId
  const response = await fetch(url, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' || options.method === 'OPTIONS' || options.method === 'DELETE'
      ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
  const text = await response.text()
  let parsed
  try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = text }
  return { status: response.status, headers: response.headers, body: parsed }
}

console.log('\n[auth]')
check('no token -> 401', (await send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: null })).status === 401)
check('wrong token -> 401', (await send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'nope' })).status === 401)
const badOrigin = await send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })
check('unlisted origin -> 403', badOrigin.status === 403, `got ${badOrigin.status}`)
const allowed = await send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: ORIGIN })
check('allowed origin -> 200', allowed.status === 200, `got ${allowed.status}`)
check('CORS echoes origin', allowed.headers.get('access-control-allow-origin') === ORIGIN)

console.log('\n[preflight]')
const preflight = await send(undefined, { method: 'OPTIONS', origin: ORIGIN, token: null })
check('OPTIONS -> 204 without auth', preflight.status === 204, `got ${preflight.status}`)
check('preflight allows authorization header', (preflight.headers.get('access-control-allow-headers') ?? '').includes('authorization'))

console.log('\n[handshake]')
const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }, { origin: ORIGIN })
check('initialize -> 200', init.status === 200, `got ${init.status}`)
check('negotiates requested revision', init.body?.result?.protocolVersion === '2025-06-18', JSON.stringify(init.body))
check('advertises tools capability', init.body?.result?.capabilities?.tools !== undefined)
const sessionId = init.headers.get('mcp-session-id')
check('issues Mcp-Session-Id', typeof sessionId === 'string' && sessionId.length > 0)

const oldRev = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
check('honors older supported revision', oldRev.body?.result?.protocolVersion === '2024-11-05')
const unknownRev = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
check('falls back on unknown revision', unknownRev.body?.result?.protocolVersion === '2025-06-18')

const initialized = await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId })
check('notifications/initialized -> 202 empty', initialized.status === 202 && initialized.body === undefined, `got ${initialized.status}`)

console.log('\n[tools]')
const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { sessionId })
check('tools/list -> 200', list.status === 200)
check('returns both tools', list.body?.result?.tools?.length === 2, JSON.stringify(list.body))
check('passes JSON Schema through verbatim', list.body?.result?.tools?.[0]?.inputSchema?.required?.[0] === 'command')
check('substitutes empty object schema', list.body?.result?.tools?.[1]?.inputSchema?.type === 'object')

const call = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: { command: 'echo hi' } } }, { sessionId })
check('tools/call -> 200', call.status === 200)
check('returns tool text', call.body?.result?.content?.[0]?.text === 'ran bash with {"command":"echo hi"}', JSON.stringify(call.body))
check('isError false on success', call.body?.result?.isError === false)

const failing = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'failing', arguments: {} } }, { sessionId })
check('tool failure is rpc success', failing.body?.result !== undefined && failing.body?.error === undefined)
check('tool failure sets isError', failing.body?.result?.isError === true)

const unknown = await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } }, { sessionId })
check('registry rejection is rpc error', unknown.body?.error?.code === -32603, JSON.stringify(unknown.body))

const noName = await send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }, { sessionId })
check('missing name -> invalid params', noName.body?.error?.code === -32602)

console.log('\n[protocol edges]')
check('unknown method -> -32601', (await send({ jsonrpc: '2.0', id: 7, method: 'nope/nope' }, { sessionId })).body?.error?.code === -32601)
check('bad JSON -> -32700', (await send('{not json', { sessionId })).body?.error?.code === -32700)
check('batch refused', (await send([{ jsonrpc: '2.0', id: 1, method: 'ping' }], { sessionId })).body?.error?.code === -32600)
check('non-JSON-RPC body refused', (await send({ hello: 'world' }, { sessionId })).body?.error?.code === -32600)
check('unknown session -> 404', (await send({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { sessionId: 'does-not-exist' })).status === 404)
check('GET -> 405', (await send(undefined, { method: 'GET' })).status === 405)
const deleted = await send(undefined, { method: 'DELETE', sessionId })
check('DELETE -> 204', deleted.status === 204)
check('session gone after DELETE', (await send({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { sessionId })).status === 404)

console.log('\n[agent scope]')
check('tools carry the resolved agent', lastExecuted?.agent === FAKE_AGENT, JSON.stringify(lastExecuted?.agent))

rootAgents = []
const noAgentList = await send({ jsonrpc: '2.0', id: 20, method: 'tools/list' })
check('no live agent -> explanatory error', String(noAgentList.body?.error?.message ?? '').includes('No live agent'), JSON.stringify(noAgentList.body))
const noAgentCall = await send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'bash', arguments: {} } })
check('no live agent refuses calls too', noAgentCall.body?.error !== undefined)

rootAgents = [FAKE_AGENT, FAKE_AGENT_2]
const many = await send({ jsonrpc: '2.0', id: 22, method: 'tools/list' })
// Several open sessions is the normal state of a running harness, so the
// newest wins rather than the request failing.
check('several sessions resolve to the newest', many.body?.result?.tools?.length === 0, JSON.stringify(many.body).slice(0, 160))
const newestCall = await send({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'bash', arguments: {} } })
check('calls run against the newest session', lastExecuted?.agent === FAKE_AGENT_2, JSON.stringify(newestCall.body).slice(0, 160))

rootAgents = [FAKE_AGENT]

console.log('\n[preset selection]')
{
  const presetCtx = new Context()
  await presetCtx.plugin(webServerStub)
  await presetCtx.plugin(toolsStub)
  await presetCtx.plugin(agentsStub)
  await presetCtx.plugin(plugin, { path: '/mcp2', token: TOKEN, agentPreset: 'web-delegate' })
  for (let i = 0; i < 50 && route?.path !== '/mcp2'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const presetServer = createServer((req, res) => { route.handler(req, res) })
  await new Promise((resolve) => { presetServer.listen(0, '127.0.0.1', resolve) })
  const presetUrl = `http://127.0.0.1:${presetServer.address().port}/mcp2`

  /**
   * Send one message to the preset-pinned endpoint.
   * @param body - the JSON-RPC message.
   * @returns the parsed response body.
   */
  const ask = async (body) => {
    const response = await fetch(presetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    })
    return JSON.parse(await response.text())
  }

  // FAKE_AGENT is older here, so a preset match must beat newest-wins.
  rootAgents = [FAKE_AGENT, FAKE_AGENT_2]
  check('preset picks its session, not the newest', (await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result?.tools?.length === 2)

  rootAgents = [FAKE_AGENT_2]
  const missing = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  check('missing preset names what is open', String(missing?.error?.message ?? '').includes('standard'), JSON.stringify(missing))

  presetServer.close()
  await presetCtx.stop?.()
  rootAgents = [FAKE_AGENT]
}

console.log('\n[limits]')
const big = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'bash', arguments: { command: 'x'.repeat(2_000_000) } } }),
})
check('oversized body -> 413', big.status === 413, `got ${big.status}`)

server.close()
await ctx.stop?.()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
