/**
 * MCP wire protocol: JSON-RPC 2.0 framing and the four methods a tool-only
 * server answers (`initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`), plus `ping`.
 *
 * The harness tool registry already stores raw JSON Schema, so a tool's
 * `parameters` becomes an MCP `inputSchema` verbatim — no conversion step
 * exists or is needed.
 *
 * @module dsh-mcp-server/protocol
 */

/** Protocol revisions this server speaks, newest last. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']

/** Revision answered when a client asks for one this server does not implement. */
export const PREFERRED_PROTOCOL_VERSION = '2025-06-18'

/** JSON-RPC error codes used by this server (spec-assigned values). */
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

/**
 * Whether a decoded body is a JSON-RPC message this server will act on.
 * @param message - the parsed request body.
 * @returns true when the envelope carries `jsonrpc: '2.0'` and a method name.
 */
export function isJsonRpcMessage(message) {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string'
  )
}

/**
 * Whether a JSON-RPC message is a notification (no response may be sent).
 * @param message - a validated JSON-RPC message.
 * @returns true when the message carries no id.
 */
export function isNotification(message) {
  return message.id === undefined || message.id === null
}

/**
 * Build a JSON-RPC success envelope.
 * @param id - the request id being answered.
 * @param result - the method's result value.
 * @returns the response object.
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Build a JSON-RPC error envelope.
 * @param id - the request id being answered, or null when unknown.
 * @param code - the JSON-RPC error code.
 * @param message - the human-facing error text.
 * @returns the response object.
 */
export function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/**
 * Negotiate a protocol revision.
 * @param requested - the client's `protocolVersion`, when it sent one.
 * @returns the requested revision when supported, else this server's preferred one.
 */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PREFERRED_PROTOCOL_VERSION
}

/**
 * Project harness tool schemas into MCP tool descriptors.
 *
 * `parameters` is already raw JSON Schema. An object schema is required by MCP,
 * so a tool declaring none is advertised with an empty object schema rather
 * than omitted — omission would silently shrink the catalog.
 * @param schemas - the registry's tool schemas.
 * @returns MCP `tools/list` descriptors.
 */
export function toMcpTools(schemas) {
  return schemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema:
      schema.parameters !== undefined && schema.parameters !== null
        ? schema.parameters
        : { type: 'object', properties: {} },
  }))
}

/**
 * Project a harness tool result into an MCP `CallToolResult`.
 *
 * Only text survives the projection: MCP carries text, image, audio, and
 * resource blocks, while the harness content model additionally carries block
 * kinds (reasoning, nested tool results) that have no MCP counterpart. Those
 * are rendered as text so a client never receives a silently empty result.
 * @param result - the value returned by `ctx.tools.execute()`.
 * @returns the MCP tool-call result.
 */
export function toMcpCallResult(result) {
  const blocks = Array.isArray(result.content) ? result.content : []
  const content = blocks.map(toMcpContentBlock).filter((block) => block !== undefined)
  if (content.length === 0) {
    content.push({ type: 'text', text: result.isError ? 'Tool failed with no content.' : '' })
  }
  return { content, isError: result.isError === true }
}

/**
 * Project one harness content block into an MCP content block.
 * @param block - a harness content block.
 * @returns the MCP block, or undefined when the block carries nothing renderable.
 */
function toMcpContentBlock(block) {
  if (block === null || typeof block !== 'object') return undefined
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'reasoning') return { type: 'text', text: block.text }
  // Image attachments are references into harness storage, not inline bytes;
  // an MCP image block requires base64 data this boundary does not hold.
  if (block.type === 'image') return { type: 'text', text: '[image attachment]' }
  if (block.type === 'tool-result') {
    const nested = Array.isArray(block.content) ? block.content : []
    const text = nested
      .map(toMcpContentBlock)
      .filter((entry) => entry !== undefined && entry.type === 'text')
      .map((entry) => entry.text)
      .join('\n')
    return { type: 'text', text }
  }
  return undefined
}
