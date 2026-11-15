import type { ClusterLink, GeoFlag, GeoPoint, Indicator } from 'admiralty-gate';

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

/** Persistence for provenance, incidents and the audit mirror. The audit FILE stays the authority. */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;
  /** Insert unless an item with the same hash exists. Returns whether it was inserted. */
  putItem(item: FusionItem, embedding: number[]): Promise<boolean>;
  updateItem(id: string, patch: Partial<Pick<FusionItem, 'geo' | 'geoSource' | 'ipGeo' | 'geoFlags' | 'claimedPlace' | 'spanId'>>): Promise<void>;
  getItem(id: string): Promise<FusionItem | undefined>;
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
}
