# Console: dashboard and API

```
browser (apps/web, :3000) ──HTTP + SSE──► apps/server (:4319) ──► admiralty-gate (packages/core)
                                              │
                                              ├─ data/policy.json   strict policy, edited from the dashboard
                                              └─ data/audit.jsonl   one hash chain for the whole server
```

## Run it

```bash
npm install
npm run dev        # builds the core once, then starts the API and the dashboard together
```

Open http://localhost:3000. For a production-style run: `npm run build` then `npm start`.

API keys are optional. Copy `.env.example` to `.env.local` in the repository root and set `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`. The server reads them; they are never sent to the browser (the browser only learns whether a key is present).

## API

| Endpoint | Purpose |
|---|---|
| `GET /events` | Server-sent events. Types: `tool.intercepted`, `argument.tainted`, `host.check.passed` / `host.check.failed`, `tool.decision`, `approval.requested`, `approval.resolved`, `tool.executed`, `tool.blocked`, `audit.appended`, `audit.tampered`, `audit.restored`, `policy.updated`, `session.started`, `session.message`, `session.finished`. Recent history is replayed on connect; reconnects resume from `Last-Event-ID`. |
| `GET /api/approvals` | Calls currently paused. |
| `POST /api/approvals/:id` | Body `{"approve": true}` or `{"approve": false}`. Anything else is rejected and resolves nothing. No answer within 5 minutes, or a server shutdown, counts as a denial. |
| `GET /api/sandbox/scenarios` | Scripted scenarios, available tools, which providers have a key. |
| `POST /api/sandbox/run` | `{"mode":"simulated","scenarioId":"..."}`, or `{"mode":"simulated","custom":{"operator","feed","call":{"tool","args"}}}`, or `{"mode":"anthropic"\|"openai","prompt","feed"}`. Returns `202 {"runId"}`; progress arrives on `/events`. |
| `GET /api/sandbox/runs/:id` | Status of one run. |
| `GET /api/policy`, `PUT /api/policy` | Read / replace the policy. `PUT` runs the library's `parsePolicy`; an unknown key, tier or verdict returns `400` with the reason and saves nothing. |
| `POST /api/policy/validate` | Same check without saving: `{"valid": true}` or `{"valid": false, "error"}`. |
| `GET /api/audit` | Reads the file from disk, verifies every link, returns `entries`, `chainValid`, and on failure `brokenAt` (record index) and `reason`. |
| `POST /api/audit/tamper`, `POST /api/audit/restore` | Demo: edit one record in the file / rewrite the file from the server's in-memory chain. Disable with `ADMIRALTY_TAMPER_DEMO=0`. |
| `POST /api/grounding` | `{"report", "sources":[{"text","id","kind","grade","owner","trusted"}]}` → per-sentence support, `independentOrigins`, `level` (`verified` = 2+ independent sources, `single`, `weak`, `ungrounded`, `operator`), `unsupportedSpecifics`. |
| `POST /api/mcp/calls` | Used by `mcp-bridge`: reports a decision from a real MCP proxy; for `require_approval` the response waits for the human. |

## The playground

- **Red-team scenarios.** A scripted model that obeys whatever it reads, the same worst-case stand-in the red-team suite uses. Each scenario states the outcome expected under the default policy, and a server test asserts all of them. Editing the policy changes what happens, which is the point.
- **Custom call.** Your operator text, your feed text, your tool call.
- **Real model.** An actual agent loop: Anthropic through the official SDK (`claude-opus-5-5` unless `ANTHROPIC_MODEL` is set; server-side refusal fallback is enabled, so a request a safety classifier declines is retried on Anthropic's recommended fallback model), or OpenAI through chat-completions function calling (`OPENAI_MODEL`, default `gpt-4o`). The operator text is the user message; the feed text is what the `search_news` tool returns.

All five sandbox tools return canned text. No lookup, scan or alert is ever performed.

## Security notes

- Loopback only by default, no authentication, and it can approve tool calls and rewrite the policy. Treat it like a debugger, not a service.
- State-changing requests carrying an `Origin` other than the dashboard's are refused, so a web page on another site cannot click "Approve" through your browser. CORS responses are limited to the same origins (`WEB_ORIGIN`).
- An audit file that fails verification at start-up is renamed to `audit.jsonl.broken-<timestamp>` and a new chain starts with a record saying so. The server never appends to a broken chain.
- An invalid `policy.json` stops the server at start-up.

## What was and was not verified

Covered by `apps/server/test`: every scenario's outcome, the approval queue (approve, deny, malformed answer, double answer, timeout, shutdown, cross-origin), SSE over a real socket, chain verification (edit, deletion, garbage line, start-up quarantine), policy validation and persistence, grounding, the MCP bridge against a real child MCP server process, and both agent loops **against stubbed providers**.

Not verified here: the Anthropic and OpenAI loops against the live APIs (no key was available when this was written), and the dashboard has no automated UI tests; it was exercised by hand and with a headless-browser walkthrough.
