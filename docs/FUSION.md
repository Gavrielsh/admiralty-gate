# Fusion workbench

```
collectors (MCP, behind McpGateProxy) ─┐
POST /api/ingest ──────────────────────┼─► ingest-osint ─► geo-enrich ─► corroborate-cluster ─► incidents
POST /api/ingest/ledger (HMAC) ────────┘        │              │                 │
                                     ProvenanceLedger     gazetteer,      clusterItems, corroborate,
                                     (untrusted, graded)  GeoIP table     canRelease  (packages/core)
```

Everything that decides lives in `packages/core`, which stays free of dependencies and I/O. `apps/server` moves data between the core, a store and a queue.

## Invariants

- **Untrusted by default.** Every ingested item is written to the `ProvenanceLedger` with `addUntrusted` and an Admiralty grade before anything is computed from it. An item with no grade is recorded as `F6`, which carries no evidential weight. Collector output passes through `McpGateProxy`; webhook and API items go straight to the ledger. Nothing ingested is ever a trusted span, so nothing ingested can authorise a tool call.
- **The audit file is the authority.** `audit.jsonl` is still the hash chain that gets verified. The store holds a mirror for querying; `GET /api/audit` reports whether the mirror's head matches.
- **Policy is hot-reloaded only if valid.** An edit to `policy.json` on disk is applied without a restart when it passes `parsePolicy`; otherwise a `policy.rejected` event is emitted and the running policy is kept.
- **Secrets live in `.env.local`.**

## Clustering rules (core)

`clusterItems` still merges by owner, citation and near-duplicate text. Three further rules are opt-in:

| Rule | Option | Notes |
|---|---|---|
| Shared hard indicators | `indicators` | Uses indicators describing who *produced* an item (`Item.indicators`). Indicators merely *mentioned* in text are used only with `fromText: true`: ten outlets reporting on one IP all mention it. An indicator carried by more than `maxShare` of the items is ignored (a NAT address, an exchange wallet). |
| Temporal burst | `burst.windowMs` | Needs a second signal by default (a shared indicator or similar text), because independent outlets legitimately report the same event within minutes. `requireSignal: false` links on timing alone. |
| Spatial proximity | `proximity.radiusKm` | Optionally also within a time window. Two independent witnesses in one place would be merged, so use it for event streams, not for news. |

Every rule can only merge. A wrong merge lowers the independent-source count; it cannot inflate confidence.

Geospatial consistency is a flag, not a merge: coordinates far from every place the item names (`toponym-mismatch`), or far from its IP geolocation (`ip-geo-mismatch`). A flagged supporting item blocks release (`blockGeoMismatch`). The bundled gazetteer is a coarse sample of about twenty boxes; pass your own for real coverage.

## Stores and queues

| | Default | With services |
|---|---|---|
| Store | in memory, lost on restart | `DATABASE_URL`: PostgreSQL. Items in `fusion_items` with a `GEOGRAPHY(Point, 4326)` column (bounding-box filters, `ST_SnapToGrid` heatmap) and a `vector(256)` column (nearest-text search). |
| Queue | in-process, sequential | `REDIS_URL`: BullMQ queues `ingest-osint`, `geo-enrich`, `corroborate-cluster`, with retries. |

The embedding is a feature-hashed character-trigram vector. It is **lexical**: it finds similar spelling, not similar meaning, and needs no model. Pass a real embedding function of dimension 256 as `embed` in the app options for semantic search.

What stays in memory regardless: pending approvals, the SSE backlog, sandbox runs and call records.

## Collectors

`data/collectors.json`, written by the operator:

```json
{
  "sources": [
    { "id": "ports-feed", "type": "feed", "location": "https://feeds.example.org/ports.xml", "grade": "B2" },
    { "id": "harbour-watch", "type": "telegram-export", "location": "/data/exports/harbour/result.json", "grade": "D3" },
    { "id": "osiris-recon", "type": "jsonl", "location": "/data/osiris/recon.jsonl", "grade": "C3", "claim": "port-incident" }
  ]
}
```

`POST /api/collectors/run {"id": "ports-feed"}` starts the collector MCP server as a child process with `McpGateProxy` in front of it. The source's `location` is the only trusted text, so a call for any other URL or path is denied before the collector sees it, and the decision lands in the audit chain. There is no scheduler: call the route from cron or your own job runner.

- `feed`: RSS 2.0 and Atom over HTTP(S).
- `telegram-export`: a Telegram Desktop export (`result.json`). A forwarded message is attributed to the channel it was forwarded from, which is what lets ten channels forwarding one post count as one origin. Live collection through the Telegram API is not included.
- `jsonl`: one JSON object per line with a `text`, `summary` or `title`; optional `id`, `at`, `lat`, `lon`, `place`, `claim`, `stance`.

## Ledger anomaly webhook

Disabled until `LEDGER_WEBHOOK_SECRET` is set. Sign the exact request body:

```bash
BODY='{"events":[{"id":"e1","account":"acct-1","ip":"203.0.113.5","proxy":false,"wallet":"0xabc...","device":"fp-1","lat":34.68,"lon":33.04}]}'
TS=$(date +%s%3N)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$LEDGER_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST http://127.0.0.1:4319/api/ingest/ledger -H 'content-type: application/json' \
  -H "x-admiralty-timestamp: $TS" -H "x-admiralty-signature: sha256=$SIG" -d "$BODY"
```

A timestamp more than five minutes old is refused. Events become `ledger` items graded `B2` unless the body carries `"grade"`. Accounts joined by a shared wallet, device or non-proxy IP form a ring once three accounts are linked. A proxy or VPN address is kept as information but never links two accounts. IP geolocation comes only from `GEOIP_CSV` (`cidr,lat,lon[,label]`, IPv4, longest prefix wins); no GeoIP data is bundled and no service is called.

A ring is a detection for an analyst to review. It is never marked released.

## Views

- **Fusion map.** Released, quarantined and ring incidents differ in colour and in shape (filled, hollow, haloed), with a text legend. The colours were checked as a set for colour-vision deficiency against the dark surface. The base map is country outlines from Natural Earth, bundled, so no tile server is contacted; set `NEXT_PUBLIC_MAP_STYLE_URL` to use real tiles.
- **Corroboration.** Supporting items against independent origins, the noisy-OR numbers with the release thresholds marked, the grade distribution, and each origin with the reason its members were merged. Untick "shared indicators" and "time bursts" to see what a pipeline without them would count.
- **ACH matrix.** Click cells to score them. The banner states whether the leading hypothesis may be given as the attribution; it is blocked when the lead is thin, when too little evidence discriminates, or when the conclusion flips on the removal of one weak item.

## Responsible use

The same rules as the rest of the project. The fusion pipeline works on incidents, infrastructure and a platform's own fraud telemetry. In the OSIRIS adapter, `geo-enrich` on anything other than a host, IP or coordinate pair, and every `entity-graph` call, are tiered as person lookups: a target that came from feed text is denied.

## What was and was not verified

Verified by tests: the core rules (mutation-checked); every server route on the in-memory backend and again on PostgreSQL 16 with PostGIS 3.4 and pgvector 0.6 plus BullMQ on Redis 7, with identical assertions; restart recovery from PostgreSQL; the webhook signature; collectors against a local HTTP feed and local files, including refusal of an unconfigured location. The three views were exercised in a headless browser against the PostgreSQL and BullMQ backend.

Not verified:
- `docker-compose.yml` and `docker/postgres/Dockerfile` were written but not run (no Docker daemon was available). The database and Redis were tested as locally installed services of the same versions.
- The `fusion-services` CI job has not run on GitHub's runners.
- Collectors were not run against real third-party feeds or real Telegram exports; the export parser follows the documented `result.json` layout.
- Tool names `osint-fetch`, `geo-enrich` and `entity-graph` were tiered as requested and not checked against the upstream OSIRIS repository.
- Throughput. Clustering is quadratic per claim and ring detection reads every ledger event on each recompute, which is fine for thousands of items and not for millions.
- The sample gazetteer's boxes are approximate and were written from general knowledge, not from a geographic dataset.
