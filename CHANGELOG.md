# Changelog

## 0.3.0

- Repository is now an npm workspace: the library moved to `packages/core` (package name and API unchanged).
- `apps/server`: Fastify API around the library: SSE event stream, human-approval queue, sandbox runner (scripted red-team scenarios, Anthropic and OpenAI agent loops), policy read/write through the strict validator, audit read with chain verification, grounding analysis, and an MCP bridge that uses the dashboard as the approval channel.
- `apps/web`: Next.js dashboard with live interceptor, grounding inspector, audit viewer and policy editor.
- Core: `McpProxyOptions.approve` / `StdioProxyOptions.approve` for out-of-band human approval instead of MCP elicitation; `isAuthorisedHost` exported.

## 0.2.0

Security fixes (upgrade from 0.1.0):
- Active-probe targets must be exactly one host. `"evil.example lab.example"` and `"evil.example,x.lab.example"` previously passed the authorised-target suffix check.
- Array and object target values are walked and checked element by element; previously they skipped the authorised-target check.
- A `lookup-person` or `active-probe` call with no recognised target argument now needs approval; previously it was allowed as "all target arguments trace to the operator".
- Tool names are looked up as own properties, so `constructor`, `toString` and similar no longer resolve to `Object.prototype`.

Added:
- `GuardedSession` for any tool-calling loop; converters for Anthropic and OpenAI tool-call shapes.
- MCP gate proxy (`admiralty-gate mcp-proxy`) with human approval through MCP elicitation.
- `parsePolicy`: strictly validated JSON policy. `targetArgs: "*"`, `defaultTool`, `onTaintedSensitive`.
- `groundReport`: sentence-level source lineage for drafted reports.
- `AuditLog.file()`, `head()`, chain resume; CLI `verify-audit`, `decide`, `ground`.
- Build to `dist/` with type declarations, `exports`, `bin`; CI on Node 20 and 22.

## 0.1.0

Initial release.
