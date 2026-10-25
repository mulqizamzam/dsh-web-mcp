/**
 * Request admission for the MCP endpoint.
 *
 * The harness `/api` fence is deliberately not reused here. That fence refuses
 * any request carrying an `Origin` that is not the server's own authority,
 * which is exactly what a browser extension sends (`chrome-extension://<id>`),
 * and it is documented as a reachability policy rather than authentication.
 * This endpoint faces a different caller and needs both halves:
 *
 * - Host fence — the DNS-rebinding defense, kept verbatim in spirit. A browser
 *   fills `Host` from the name it believes it is talking to, so a rebound page
 *   carries the attacker's domain even though the socket lands here.
 * - Origin allowlist — extension origins are opaque ids, so they are declared
 *   rather than inferred. `null` (sandboxed frames, file: pages) never matches.
 * - Bearer token — the actual authentication. Compared in constant time so a
 *   wrong token cannot be recovered byte-by-byte from response timing.
 *
 * @module dsh-mcp-server/trust
 */

import { timingSafeEqual } from 'node:crypto'

/** Loopback hostnames that always satisfy the Host fence. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Read one header as a single string.
 * @param headers - the Node request headers.
 * @param key - the lowercase header name.
 * @returns the value, or undefined when absent or repeated.
 */
function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a bare `host` or `host:port` authority through WHATWG normalization.
 * @param authority - the raw Host header value.
 * @returns the parsed URL, or undefined when unparsable.
 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a hostname is loopback.
 * @param hostname - the WHATWG-normalized hostname.
 * @returns true for loopback names and the 127.0.0.0/8 range.
 */
function isLoopbackHostname(hostname) {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * Compare two secrets without leaking their common prefix length.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a length
 * mismatch; a length difference is not the secret.
 * @param actual - the token presented by the caller.
 * @param expected - the configured token.
 * @returns true when the tokens are byte-identical.
 */
function secretEquals(actual, expected) {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether the request authority matches a `trustedHosts` entry.
 *
 * An entry written with an explicit port matches that exact authority; a
 * port-less entry matches the hostname on any port, which is the shape a
 * deployment uses when the bound port is OS-assigned. Both sides compare
 * through WHATWG normalization so case and a redundant `:80` never decide
 * trust.
 * @param hostUrl - the parsed Host authority.
 * @param trustedHosts - the configured entries.
 * @returns true when one entry matches.
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return entryUrl.port === ''
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach the MCP dispatcher.
 * @param req - the incoming Node request.
 * @param policy - `token`, `trustedHosts`, and `allowedOrigins` from config.
 * @returns `{ ok: true }`, or `{ ok: false, status, message }` naming the refusal.
 */
export function admitRequest(req, policy) {
  const host = header(req.headers, 'host')
  if (host === undefined) return { ok: false, status: 403, message: 'Missing Host header.' }
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return { ok: false, status: 403, message: 'Unparsable Host header.' }
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, policy.trustedHosts)) {
    return { ok: false, status: 403, message: 'Host is not a trusted authority.' }
  }

  const origin = header(req.headers, 'origin')
  if (origin !== undefined && !isSameAuthority(origin, hostUrl) && !policy.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, message: 'Origin is not allowed.' }
  }

  const authorization = header(req.headers, 'authorization')
  if (authorization === undefined) {
    return { ok: false, status: 401, message: 'Missing bearer token.' }
  }
  const match = /^Bearer (.+)$/.exec(authorization)
  if (match === null || !secretEquals(match[1], policy.token)) {
    return { ok: false, status: 401, message: 'Invalid bearer token.' }
  }

  return { ok: true }
}

/**
 * Whether an Origin names this same server.
 *
 * Only the authority is compared, never the scheme: the Host header carries no
 * scheme, so reconstructing one would make an https deployment reject its own
 * same-origin requests. The opaque literal `null` fails to parse and so never
 * matches, which is the intent — a sandboxed frame is not same-origin.
 * @param origin - the caller's Origin header.
 * @param hostUrl - the parsed Host authority.
 * @returns true when the origin's authority equals the Host authority.
 */
function isSameAuthority(origin, hostUrl) {
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * CORS headers for the MCP endpoint.
 *
 * A browser extension calling from its own origin sends a preflight for the
 * `authorization` and `mcp-session-id` headers, so the allowance is echoed
 * per-origin rather than wildcarded — `*` cannot be combined with credentials
 * and would also advertise the endpoint to every page.
 * @param origin - the caller's Origin header, when present.
 * @param policy - the admission policy holding `allowedOrigins`.
 * @returns the response headers to merge, empty when the origin is not allowed.
 */
export function corsHeaders(origin, policy) {
  if (origin === undefined || !policy.allowedOrigins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
    'access-control-expose-headers': 'mcp-session-id',
    'access-control-max-age': '600',
  }
}
