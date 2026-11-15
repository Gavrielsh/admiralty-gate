#!/usr/bin/env node
/**
 * Collector MCP server (stdio, newline-delimited JSON-RPC). It only fetches and parses; it decides nothing.
 * The server runs it behind McpGateProxy, so a URL or path that the operator did not configure is refused before
 * this process ever sees the call, and everything it returns is recorded as untrusted.
 *
 * Tools: collect_feed {url}, collect_telegram_export {path}, collect_jsonl {path}
 */
import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseFeed, parseJsonl, parseTelegramExport, type CollectedItem } from './parse.js';

const MAX_BYTES = 5 * 1024 * 1024;
const TOOLS = [
  { name: 'collect_feed', description: 'Fetch an RSS or Atom feed and return its items.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'collect_telegram_export', description: 'Read a Telegram Desktop chat export (result.json).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'collect_jsonl', description: 'Read a JSON-lines file of tool output.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

function readCapped(path: string): string {
  if (statSync(path).size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES} bytes`);
  return readFileSync(path, 'utf8');
}

async function collect(name: string, args: Record<string, unknown>): Promise<CollectedItem[]> {
  if (name === 'collect_feed') {
    const url = new URL(String(args.url));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) feeds are supported');
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' } });
    if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('feed is too large');
    return parseFeed(body);
  }
  if (name === 'collect_telegram_export') return parseTelegramExport(readCapped(String(args.path)));
  if (name === 'collect_jsonl') return parseJsonl(readCapped(String(args.path)));
  throw new Error(`unknown tool ${name}`);
}

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  let m: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  const id = m.id;
  if (m.method === 'initialize')
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'admiralty-collectors', version: '0.4.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (m.method === 'tools/call')
    return void collect(m.params?.name ?? '', m.params?.arguments ?? {}).then(
      items => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(items) }] } }),
      (e: Error) => send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `collector error: ${e.message}` }] } }),
    );
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
