# Changelog

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
