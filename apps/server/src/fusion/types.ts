import type { ClusterLink, GeoFlag, GeoPoint, Indicator, Place } from 'admiralty-gate';

export type SourceType = 'telegram' | 'feed' | 'tool' | 'web' | 'sensor' | 'file';
export const SOURCE_TYPES: readonly SourceType[] = ['telegram', 'feed', 'tool', 'web', 'sensor', 'file'];

/** One graded, untrusted item of provenance, as stored. */
export interface FusionItem {
  id: string;
  /** SHA-256 of source + text: the de-duplication key. */
  hash: string;
  kind: 'osint' | 'ledger';
  sourceType: SourceType;
  sourceId: string;
  owner?: string;
  /** Admiralty grade, always present ("F6" when nobody graded the source). */
  grade: string;
  text: string;
  at: number;
  ingestedAt: number;
  /** Incident / claim key this item is evidence for. */
  claim?: string;
  stance?: 'supports' | 'contradicts';
  cites?: string[];
  /** Who produced it (structural). */
  indicators: Indicator[];
  /** What its text mentions (extracted). */
  mentions: Indicator[];
  geo?: GeoPoint;
  /** How `geo` was obtained. */
  geoSource?: 'supplied' | 'text' | 'gazetteer' | 'ip';
  claimedPlace?: string;
  ipGeo?: GeoPoint;
  geoFlags: GeoFlag[];
  /** Places the item names, as resolved at enrichment (GeoNames, Nominatim or the sample gazetteer). */
  places?: Place[];
  /** Id of the span in the provenance ledger. */
  spanId?: string;
  meta?: Record<string, unknown>;
}

export type IncidentStatus = 'released' | 'quarantined' | 'ring';

/** A corroborated claim, or a detected ring of linked ledger events. */
export interface Incident {
  id: string;
  kind: 'claim' | 'ring';
  status: IncidentStatus;
  title: string;
  geo?: GeoPoint;
  released: boolean;
  reasons: string[];
  confidence: number;
  phrase?: string;
  independentSupport: number;
  rawItems: number;
  echoReduction: number;
  bestGrade?: string;
  flags: string[];
  firstAt: number;
  lastAt: number;
  memberIds: string[];
  links: ClusterLink[];
  /** Indicators shared by two or more members. */
  sharedIndicators: string[];
  updatedAt: number;
}

export type BBox = [west: number, south: number, east: number, north: number];

export interface ItemQuery {
  claim?: string;
  kind?: FusionItem['kind'];
  sourceType?: SourceType;
  /** Both axes at least this good, e.g. "B2". */
  minGrade?: string;
  since?: number;
  until?: number;
  bbox?: BBox;
  /** "kind:value" */
  indicator?: string;
  /** Rank by embedding similarity to this vector instead of by time. */
  near?: number[];
  hasGeo?: boolean;
  limit?: number;
}

export interface IncidentQuery {
  released?: boolean;
  kind?: Incident['kind'];
  minGrade?: string;
  since?: number;
  until?: number;
  bbox?: BBox;
}

export interface HeatQuery {
  /** Grid cell size in degrees. */
  cell: number;
  kind?: FusionItem['kind'];
  proxyOnly?: boolean;
  since?: number;
  until?: number;
  bbox?: BBox;
}

export interface HeatCell {
  lat: number;
  lon: number;
  count: number;
}

export interface AuditMirrorRow {
  seq: number;
  hash: string;
  prev: string;
  kind: string;
  at: number;
  data: unknown;
}

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'timeout' | 'expired';
export interface ApprovalRow {
  id: string;
  callId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  tier?: string;
  reasons: string[];
  provenance: unknown[];
  requestedAt: number;
  expiresAt: number;
  state: ApprovalState;
  resolvedAt?: number;
  note?: string;
}

/** A stored tool-call record (the dashboard's timeline entry). `doc` is the CallRecord. */
export interface CallRow {
  id: string;
  at: number;
  doc: unknown;
}

export interface IncidentSnapshot {
  at: number;
  status: IncidentStatus;
  released: boolean;
  confidence: number;
  independentSupport: number;
  rawItems: number;
  flags: string[];
  reasons: string[];
}

export interface IndicatorGroup {
  key: string;
  itemIds: string[];
}

/** Persistence for provenance, incidents, approvals, call records and the audit mirror. The audit FILE stays the authority. */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  /** Create or migrate storage for vectors of length `dim`. `reembed` is true when stored vectors had another length and were dropped. */
  init(dim: number): Promise<{ reembed: boolean }>;
  close(): Promise<void>;
  /** Insert unless an item with the same hash exists. Returns whether it was inserted. */
  putItem(item: FusionItem, embedding: number[]): Promise<boolean>;
  updateItem(id: string, patch: Partial<Pick<FusionItem, 'geo' | 'geoSource' | 'ipGeo' | 'geoFlags' | 'claimedPlace' | 'spanId' | 'places' | 'meta'>>): Promise<void>;
  getItem(id: string): Promise<FusionItem | undefined>;
  getItems(ids: readonly string[]): Promise<FusionItem[]>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  /** Items in id order after `afterId`, for re-embedding in batches. */
  pageItems(afterId: string, limit: number): Promise<{ id: string; text: string }[]>;
  /** Pairs of items within one claim whose embeddings are at least `minScore` similar (cosine). */
  similarPairs(claim: string, minScore: number, limit?: number): Promise<{ a: string; b: string; score: number }[]>;
  /**
   * Ledger events grouped by a structural indicator that at least two accounts share, since `since`.
   * An indicator carried by more than `maxHolders` events is left out (a NAT address, an exchange wallet).
   */
  sharedIndicatorGroups(q: { since?: number; kinds: readonly string[]; maxHolders: number }): Promise<IndicatorGroup[]>;
  /** Every ledger event id of the given accounts since `since` (an account's own events are one origin). */
  accountEvents(accounts: readonly string[], since?: number): Promise<IndicatorGroup[]>;
  /** Pairs of ledger events from different accounts within `radiusM` metres and `windowMs` of each other. */
  proximityPairs(q: { since?: number; radiusM: number; windowMs: number; limit?: number }): Promise<[string, string][]>;
  countLedger(since?: number): Promise<number>;
  queryItems(q: ItemQuery): Promise<FusionItem[]>;
  countItems(): Promise<number>;
  claims(): Promise<string[]>;
  putIncident(i: Incident): Promise<void>;
  /** Replace every incident of a kind in one step (ring membership changes as events arrive). */
  replaceIncidents(kind: Incident['kind'], list: Incident[]): Promise<void>;
  queryIncidents(q: IncidentQuery): Promise<Incident[]>;
  heatmap(q: HeatQuery): Promise<HeatCell[]>;
  mirrorAudit(r: AuditMirrorRow): Promise<void>;
  /** Drop mirror rows from `fromSeq` on (used when the file chain is restarted). */
  truncateAuditMirror(fromSeq: number): Promise<void>;
  auditMirror(): Promise<{ count: number; head: string | null }>;
  putCall(row: CallRow): Promise<void>;
  listCalls(limit: number): Promise<CallRow[]>;
  putApproval(row: ApprovalRow): Promise<void>;
  listApprovals(q: { state?: ApprovalState; limit?: number }): Promise<ApprovalRow[]>;
  /** Mark every approval still pending as expired (their paused calls died with the previous process). Returns how many. */
  expirePendingApprovals(note: string, at: number): Promise<number>;
  appendIncidentHistory(id: string, s: IncidentSnapshot): Promise<void>;
  incidentHistory(id: string): Promise<IncidentSnapshot[]>;
  getGeocode(query: string): Promise<{ hit: boolean; place?: Place }>;
  putGeocode(query: string, place: Place | undefined): Promise<void>;
  getKv(key: string): Promise<string | undefined>;
  putKv(key: string, value: string): Promise<void>;
}
