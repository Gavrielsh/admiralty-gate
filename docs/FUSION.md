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
| Store | in memory, lost on restart | `DATABASE_URL`: PostgreSQL. Items in `fusion_items` with a `GEOGRAPHY(Point, 4326)` column (bounding-box filters, `ST_SnapToGrid` heatmap, `ST_DWithin` joins) and a `vector(N)` column with an HNSW index. Also: incidents and their history, tool-call records, approvals, the audit mirror, a geocode cache. |
| Queue | in-process, sequential | `REDIS_URL`: BullMQ queues `ingest-osint`, `geo-enrich`, `corroborate-cluster`, with retries. |

What still lives only in memory: the SSE backlog, sandbox run status, and the promise behind a paused tool call. A paused call cannot outlive the process that paused it: after a restart its approval is recorded as `expired` and the call is recorded as never executed.

## Embeddings

`EMBEDDING_PROVIDER` selects the provider. The server computes vectors; the core only ever receives scores.

| Provider | What it is |
|---|---|
| `local` (default) | `@huggingface/transformers` on ONNX with `Xenova/multilingual-e5-small` (384 dimensions; Hebrew, Arabic, English and about a hundred other languages). The model is downloaded on first start and cached (`EMBEDDING_CACHE_DIR`); after that it runs offline. `EMBEDDING_MODEL` picks another one. |
| `http` | Any OpenAI-compatible endpoint: `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`. |
| `mock` | Feature-hashed character trigrams. Lexical, not semantic. For tests. |

If the chosen provider cannot start (no network for the first download, a bad URL), the server still starts on the mock and says so at start-up and in `GET /api/fusion/status` (`embedding.degraded`). The vector column is created at the provider's dimension. Starting with a provider of a different dimension rebuilds the column and re-embeds every stored item.

Where semantic scores are used:
- `GET /api/provenance?q=`: nearest items by meaning.
- `POST /api/grounding`: a sentence with little shared wording but a close match in meaning is `paraphrase`, which is weaker than `grounded` and labelled as model-judged.
- `POST /api/corroborate`: two items of one claim that mean the same thing **and** were posted inside the burst window are merged (a translated repost). Similar meaning alone never merges: two independent outlets reporting one event are similar too. The threshold (0.92 cosine) is a starting point, not a calibrated value; it depends on the model.

## Geolocation

- **IP addresses.** Download `GeoLite2-City.mmdb` and optionally `GeoLite2-ASN.mmdb` from MaxMind (free account, their licence applies) and set `MAXMIND_CITY_DB_PATH` / `MAXMIND_ASN_DB_PATH`. The files are read locally with `@maxmind/geoip2-node`; nothing is sent anywhere. `GEOIP_CSV` still works and takes precedence. A missing or unreadable file is reported and ignored.
- **Place names.** `GEONAMES_TSV_PATH` points at a GeoNames dump (`cities15000.txt`, `cities1000.txt`, ...; CC BY 4.0). Names and alternate names, in any script, are indexed; lookup is by n-gram, so it does not slow down with the size of the file. For a name shared by several places the most populous wins, and a lower-case Latin word that is also a town ("nice", "reading") is not treated as a place. `NOMINATIM_URL` adds a geocoder for explicit place claims (`claimedPlace`) that the local data does not know; answers, including "not found", are cached in the store, failures are not, and requests are spaced at least 1.1 s apart. Use your own Nominatim instance for anything beyond light use. Without either, the small sample gazetteer is used.

## Fraud rings at scale

Ring detection no longer loads every ledger event. The store filters by time (`RING_WINDOW_HOURS`, default 7 days), groups by structural indicator, keeps groups that at least two accounts share, and drops any indicator carried by more than half of the events in the window. Only events in such a group come back; the core then finds connected components among them. A proxy or VPN address is never stored as a linking indicator, so it cannot join accounts.

`RING_PROXIMITY_KM` adds a second kind of link: events from different accounts within that distance and within `RING_PROXIMITY_WINDOW_MIN` of each other. In PostgreSQL this is an `ST_DWithin` self-join on the geography column.

Clustering itself is near-linear in the core (inverted indexes, a time sweep, a spatial grid): 10,000 events in about 110 ms on the machine this was written on. Two honest limits: a single group of thousands of near-identical texts still costs roughly the square of its size to verify, and `indicators.minShared > 1` counts per pair.

## Authentication

Set `ADMIRALTY_API_KEY`. Every `/api` route and `/events` then needs `Authorization: Bearer <key>` or `x-api-key: <key>`. Two routes are exempt: `/api/health`, and `/api/ingest/ledger`, which authenticates each request by HMAC. Without a key the server only starts on a loopback address. The dashboard asks for the key and keeps it in the tab's session storage; it is not built into the page. The MCP bridge reads `ADMIRALTY_API_KEY` from its environment. One shared key is not user management: there are no accounts or roles, and TLS is up to whatever you put in front.

## Default policy: OSIRIS tools

A new `policy.json` registers `osint-fetch`, `geo-enrich` and `entity-graph` (and the underscore spellings):

| Tool | Tier | Traced arguments | Effect |
|---|---|---|---|
| `osint-fetch` | `lookup-infra` | `url`, `source`, `channel`, `feed`, `query`, `target` | operator-typed target: allowed; target from feed text: a human decides |
| `geo-enrich` | `lookup-person` | all | operator-typed: allowed; from feed text: blocked |
| `entity-graph` | `lookup-person` | all | same |

`geo-enrich` is stricter here than in the OSIRIS adapter, which tiers it by what the target looks like; a JSON policy cannot express that, so it takes the safer tier. `port_scan` stays `active-probe`, `send_alert` stays `publish`, and unlisted tools are still blocked. An existing `policy.json` is never edited for you: add the rules in the policy editor, or delete the file to regenerate it.

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
- **Live Telegram.** Set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (from my.telegram.org), run `npm run telegram:login -w @admiralty-gate/server` once to obtain `TELEGRAM_SESSION`, and list public channel usernames in `TELEGRAM_CHANNELS` (`name:D3,other`; the grade defaults to `F6`). The collector process holds one MTProto connection (GramJS); every `TELEGRAM_POLL_SECONDS` the server asks it, through the gate proxy, for messages newer than each channel's cursor. Each request is therefore a gated, audited `telegram_poll` call whose only trusted text is your channel list: a channel named in a message cannot be polled. Messages are ingested as untrusted items; a forward is attributed to the channel it came from. The cursor is stored, so a restart resumes where it stopped. The session string gives access to the Telegram account: keep it in `.env.local` only, and use an account you are content to dedicate to this.
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

Verified by tests, on the in-memory backend and again on PostgreSQL 16 (PostGIS 3.4, pgvector 0.6) with BullMQ on Redis 7:
- Core: clustering parity against the previous pairwise implementation on 400 random inputs over every option combination; scale tests (10,000 events under 200 ms).
- API key enforcement on every route and on the event stream over a real socket; loopback-only start without a key.
- Stored tool calls, approvals and incident history; restart recovery from PostgreSQL, including expiry of an approval left pending.
- Ring detection in the store: grouping, hub cap, time window, account bridging, proxy exclusion, and `ST_DWithin` proximity.
- The HTTP embedding provider against a local OpenAI-compatible stub: dimension discovery, semantic clustering and grounding, and the vector-column rebuild when the dimension changes.
- MaxMind reading against MaxMind's public test databases (city and ASN).
- GeoNames parsing against a six-row sample in the real file layout; Nominatim against a local stub, with the cache.
- The Telegram streamer end to end with the real gate, proxy, collector process, queue and store, and a **stand-in driver** in place of GramJS.
- The dashboard in a headless browser on PostgreSQL and BullMQ: key prompt (wrong and right key), timeline restored after a reload, and the map falling back to outlines when the style URL is unreachable.
- `docker compose config` accepts `docker-compose.yml`; the `postgis/postgis:16-3.4` base image pulls.

Not verified (the sandbox this was built in has no route to the hosts involved):
- **The local embedding model.** `huggingface.co` was unreachable, so `Xenova/multilingual-e5-small` was never downloaded or run. The provider code follows the transformers.js API and type-checks; what was observed is its failure path (it degrades to the mock in about 4 s and reports why).
- **The GramJS driver and the login script.** No Telegram credentials. They type-check against the `telegram` package.
- **The PostgreSQL image build.** Debian's and PostgreSQL's apt repositories were blocked, so `postgresql-16-pgvector` could not be installed inside the image. The Dockerfile and init script were not run.
- **OpenFreeMap tiles.** The style URL in `.env.example` could not be fetched; only the fallback was exercised.
- **Real GeoNames and GeoLite2 files**, and the public Nominatim service.
- **The `fusion-services` CI job** on GitHub's runners.
- The semantic merge threshold (0.92) against a real model.
