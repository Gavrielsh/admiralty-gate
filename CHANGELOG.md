# Changelog

## 0.5.0

Core (still zero dependencies, no I/O):
- `clusterItems` no longer compares every pair: an exact prefix-filtered similarity join for near-duplicate text, posting lists for indicators, a time sweep for bursts and a unit-sphere grid for proximity. Same partition as before (parity-tested against the 0.4 code on 400 random inputs); 10,000 events cluster in about 110 ms. `links` reports every pair for groups up to 64 and a connecting chain above that.
- `ClusterOptions.semantic` and `GroundOptions.semanticMatches`: similarity scores computed by the caller. New grounding status `paraphrase`.

Server:
- `EmbeddingProvider`: local transformers.js model (default), OpenAI-compatible HTTP, mock. The pgvector column follows the provider's dimension; stored items are re-embedded when it changes.
- GeoIP from MaxMind `.mmdb` (city, ASN); place names from a GeoNames dump and/or Nominatim with a cache in the store.
- Fraud rings computed in the store: time window, `GROUP BY` on shared indicators with the hub cap, optional `ST_DWithin` self-join.
- Tool calls, approvals and incident history persisted; approvals left pending by a dead process are marked expired.
- `ADMIRALTY_API_KEY` on every `/api` route and `/events`; the server refuses a non-loopback address without it.
- Live Telegram collector (GramJS) polled through `McpGateProxy`.
- Default policy registers `osint-fetch`, `geo-enrich`, `entity-graph`.

Web: API-key prompt, timeline restored from stored records, street-level base map with fallback to the bundled outlines.

## 0.4.0

Core (still zero dependencies, no I/O):
- `entities`: deterministic hard-indicator extraction. `geo`: haversine, coordinates in text, gazetteer check of coordinates against named places and IP geolocation.
- `clusterItems`: opt-in merging by shared indicators (with hub suppression), temporal bursts and spatial proximity; returns `links` and `geoFlags`. Existing callers are unaffected.
- `corroborate` / `canRelease`: `coordinated` and `geo-mismatch` flags, `echoReduction`, optional `blockGeoMismatch`.
- `groundReport`: `unsupportedEntities` (IPs, wallets, hashes, coordinates within a tolerance) and `unsupportedLinks` (two real identifiers no single source connects).
- `attributionGate` for ACH. OSIRIS adapter: `osint-fetch`, `geo-enrich`, `entity-graph` tiers; tool output recorded with a grade (F6 when ungraded).

Server:
- Fusion pipeline (`ingest-osint`, `geo-enrich`, `corroborate-cluster`) on an in-process queue or BullMQ/Redis; store in memory or PostgreSQL with PostGIS and pgvector.
- Collector MCP server (feeds, Telegram exports, JSONL) run behind `McpGateProxy`; HMAC-signed ledger webhook; offline GeoIP table; ring detection.
- New routes: `/api/ingest`, `/api/provenance`, `/api/corroborate`, `/api/ach`, `/api/geo/incidents`, `/api/geo/heatmap`, `/api/collectors`, `/api/ingest/ledger`.
- Audit mirror in the store (the file stays the authority); `policy.json` hot reload.

Web: fusion map (MapLibre, offline outlines), corroboration breakdown, ACH matrix.

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
