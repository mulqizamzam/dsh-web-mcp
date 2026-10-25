/**
 * Verifies the queued-task path against a live `dsh web`: invoke the subagent
 * tool over MCP, confirm the task reaches the bridge, answer it, and confirm
 * the parent's tool call completes with that text.
 *
 * Requires `dsh web` running with dsh-mcp-server and dsh-subagent-deepseek-web
 * mounted, and a live session on the `web-delegate` preset.
 *
 * Run: node verify-live.mjs <bearer-token>
 */

const TOKEN = process.argv[2]
if (TOKEN === undefined) {
  console.error('usage: node verify-live.mjs <bearer-token>')
  process.exit(2)
}
const MCP = 'http://127.0.0.1:3080/mcp'

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
 * @param body - the JSON-RPC message.
 * @param sessionId - the MCP session id, when established.
 * @returns `{ status, headers, body }`.
 */
async function mcp(body, sessionId) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId
  const response = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) }
}

const init = await mcp({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-live', version: '1' } },
})
const session = init.headers.get('mcp-session-id')
check('initialize', init.status === 200 && typeof session === 'string')

const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)
const tools = list.body?.result?.tools ?? []
check('catalog is served from a live session', tools.length > 0, JSON.stringify(list.body?.error))
check('subagent_deepseek_web is exposed', tools.some((t) => t.name === 'subagent_deepseek_web'))

console.log('\n[delegated task]')
// The tool call does not settle until the task is answered, so it is started
// without awaiting and answered through the bridge below.
const pending = mcp({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'subagent_deepseek_web', arguments: { description: 'probe', prompt: 'say hello' } },
}, session)

const claimed = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'web_task_claim', arguments: {} } }, session)
const claimText = claimed.body?.result?.content?.[0]?.text ?? ''
check('a task is claimable', claimText.includes('say hello'), claimText.slice(0, 200))

const taskId = /task-[0-9a-f-]+/.exec(claimText)?.[0]
check('claim reports a task id', taskId !== undefined, claimText.slice(0, 200))

if (taskId !== undefined) {
  const settled = await mcp({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'web_task_settle', arguments: { taskId, text: 'hello from the browser', stopReason: 'completed' } },
  }, session)
  check('settle is accepted', settled.body?.result?.isError === false, JSON.stringify(settled.body))

  const parent = await pending
  const parentText = parent.body?.result?.content?.[0]?.text ?? ''
  check('parent tool call completes', parent.body?.result !== undefined, JSON.stringify(parent.body).slice(0, 300))
  check('parent receives the delegated reply', parentText.includes('hello from the browser'), parentText.slice(0, 300))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
