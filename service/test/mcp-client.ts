import { SELF } from 'cloudflare:test';

/**
 * HANDSHAKE FINDING (spiked against agents@0.33.0 createMcpHandler + @modelcontextprotocol/server 2.4.0):
 * a stateless `tools/call` (and `tools/list`) works as the FIRST and ONLY request. No `initialize` and no
 * `notifications/initialized` are needed, and no `Mcp-Session-Id` is issued or required. Each request is
 * answered by a fresh server built by the factory.
 *
 * Wire details a later client (the e2e script) must handle:
 * - Send `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
 * - The reply to a POST comes back as `Content-Type: text/event-stream` with one event, `data: {json-rpc}`,
 *   even though no streaming is involved. Parse the last `data:` line (a plain JSON reply is also accepted here).
 * - The `/mcp` path is exact. GET and DELETE are answered 405 (stateless: nothing to resume or close).
 * - A missing or revoked bearer token is HTTP 401 with Echo's JSON error body, before any MCP handling.
 * - Tool failures are `result.isError: true` with the explanation in `result.content[0].text`; they are
 *   never JSON-RPC errors (the tools wrap the SDK's own input validation so a bad argument reads
 *   `Refused (rule BAD_REQUEST): ...`).
 */

let nextId = 1;

function rpc(token: string | null, method: string, params: unknown): Promise<Response> {
  return SELF.fetch('https://echo.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
}

/** Reads a JSON-RPC reply that arrives as plain JSON or as one SSE `data:` event. */
function parseRpc(contentType: string, text: string): any {
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

/** One JSON-RPC request with no handshake. `json` is the parsed JSON-RPC reply, or Echo's JSON error body on 401. */
export async function mcpRaw(token: string | null, method: string, params: unknown = {}): Promise<{ status: number; json: any }> {
  const res = await rpc(token, method, params);
  const text = await res.text();
  return { status: res.status, json: parseRpc(res.headers.get('content-type') ?? '', text) };
}

/** Calls one tool; returns its flattened text and whether it was an error result. */
export async function mcpCall(token: string, tool: string, args: unknown): Promise<{ isError?: boolean; text: string }> {
  const { status, json } = await mcpRaw(token, 'tools/call', { name: tool, arguments: args });
  if (json?.error) return { isError: true, text: `HTTP ${status} JSON-RPC error ${json.error.code}: ${json.error.message}` };
  if (!json?.result) return { isError: true, text: `HTTP ${status} ${JSON.stringify(json)}` };
  return { isError: json.result.isError, text: json.result.content.map((c: { text: string }) => c.text).join('\n') };
}
