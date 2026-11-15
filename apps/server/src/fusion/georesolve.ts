/**
 * Location lookups that need data from outside the core: IP geolocation (MaxMind .mmdb and/or an operator CSV)
 * and place names (GeoNames file and/or a Nominatim endpoint with a cache). The results are handed to the core
 * as plain values (a point, a list of Place boxes).
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { canonical, tokens, type GeoPoint, type Place } from 'admiralty-gate';
import { GeoIpTable } from './geoip.js';

export interface IpLocation {
  point?: GeoPoint;
  asn?: string;
  org?: string;
  source: 'csv' | 'maxmind';
}

interface MmdbReader {
  city(ip: string): { location?: { latitude?: number; longitude?: number } };
  asn(ip: string): { autonomousSystemNumber?: number; autonomousSystemOrganization?: string };
}

export class IpResolver {
  private city: MmdbReader | undefined;
  private asnDb: MmdbReader | undefined;
  readonly notes: string[] = [];

  constructor(readonly csv: GeoIpTable) {}

  /** Opens the MaxMind databases that exist. A missing or unreadable file is noted, never fatal. */
  static async open(env: Record<string, string | undefined>): Promise<IpResolver> {
    const r = new IpResolver(GeoIpTable.fromFile(env.GEOIP_CSV));
    const load = async (path: string | undefined, label: string): Promise<MmdbReader | undefined> => {
      if (!path) return undefined;
      if (!existsSync(path)) {
        r.notes.push(`${label}: ${path} not found`);
        return undefined;
      }
      try {
        const { Reader } = await import('@maxmind/geoip2-node');
        return (await Reader.open(path)) as unknown as MmdbReader;
      } catch (e) {
        r.notes.push(`${label}: cannot read ${path} (${(e as Error).message.slice(0, 120)})`);
        return undefined;
      }
    };
    r.city = await load(env.MAXMIND_CITY_DB_PATH, 'MAXMIND_CITY_DB_PATH');
    r.asnDb = await load(env.MAXMIND_ASN_DB_PATH, 'MAXMIND_ASN_DB_PATH');
    return r;
  }

  get sources(): string[] {
    return [...(this.csv.size ? [`csv (${this.csv.size} ranges)`] : []), ...(this.city ? ['maxmind city'] : []), ...(this.asnDb ? ['maxmind asn'] : [])];
  }

  /** The operator's CSV wins over MaxMind: it is the more specific statement. */
  lookup(ip: string): IpLocation | undefined {
    const fromCsv = this.csv.lookup(ip);
    let out: IpLocation | undefined = fromCsv ? { point: fromCsv, source: 'csv' } : undefined;
    if (!out && this.city) {
      try {
        const loc = this.city.city(ip).location;
        if (typeof loc?.latitude === 'number' && typeof loc.longitude === 'number') out = { point: { lat: loc.latitude, lon: loc.longitude }, source: 'maxmind' };
      } catch {
        /* address not in the database */
      }
    }
    if (this.asnDb) {
      try {
        const a = this.asnDb.asn(ip);
        if (a.autonomousSystemNumber !== undefined) {
          out ??= { source: 'maxmind' };
          out.asn = String(a.autonomousSystemNumber);
          if (a.autonomousSystemOrganization) out.org = a.autonomousSystemOrganization;
        }
      } catch {
        /* address not in the database */
      }
    }
    return out;
  }
}

interface City {
  name: string;
  lat: number;
  lon: number;
  population: number;
}

export interface GeocodeCache {
  getGeocode(query: string): Promise<{ hit: boolean; place?: Place }>;
  putGeocode(query: string, place: Place | undefined): Promise<void>;
}

const boxAround = (name: string, lat: number, lon: number, population: number): Place => {
  // A city is a box, not a point: roughly 25 km, twice that for a metropolis.
  const d = population >= 1_000_000 ? 0.5 : 0.25;
  return { name, bbox: [lon - d, lat - d, lon + d, lat + d] };
};
const LATIN = /^[\p{Script=Latin}\s.'-]+$/u;

export class PlaceResolver {
  private readonly cities = new Map<string, City>();
  private maxTokens = 1;
  private lastCall = 0;
  readonly notes: string[] = [];

  constructor(
    private readonly o: {
      fallback: readonly Place[];
      nominatimUrl?: string;
      cache?: GeocodeCache;
      fetch?: typeof fetch;
      /** Minimum gap between Nominatim calls. The public instance asks for at most one request per second. */
      minIntervalMs?: number;
      userAgent?: string;
    },
  ) {}

  get geonamesSize(): number {
    return this.cities.size;
  }

  get sources(): string[] {
    return [...(this.cities.size ? [`geonames (${this.cities.size} names)`] : ['sample gazetteer']), ...(this.o.nominatimUrl ? ['nominatim'] : [])];
  }

  /**
   * Load a GeoNames dump (cities500 / cities1000 / cities15000 .txt; tab-separated, name in column 2, alternate
   * names in column 4, latitude and longitude in 5 and 6, population in 15). For a name shared by several places
   * the most populous one is kept.
   */
  async loadGeoNames(path: string, minPopulation = 15_000): Promise<number> {
    if (!existsSync(path)) {
      this.notes.push(`GEONAMES_TSV_PATH: ${path} not found`);
      return 0;
    }
    const add = (raw: string, c: City) => {
      const key = tokens(raw).join(' ');
      if (!key || key.length < 3) return;
      const cur = this.cities.get(key);
      if (!cur || cur.population < c.population) {
        this.cities.set(key, c);
        this.maxTokens = Math.max(this.maxTokens, Math.min(4, key.split(' ').length));
      }
    };
    for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
      const f = line.split('\t');
      if (f.length < 15) continue;
      const lat = Number(f[4]);
      const lon = Number(f[5]);
      const population = Number(f[14]) || 0;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || population < minPopulation) continue;
      const c: City = { name: f[1]!, lat, lon, population };
      add(f[1]!, c);
      add(f[2]!, c);
      // Alternate names bring other scripts (Hebrew, Arabic, Cyrillic). Short codes and URLs are skipped.
      for (const alt of (f[3] ?? '').split(',')) if (alt.length >= 3 && !alt.includes('/') && !/^[A-Z]{3,4}$/.test(alt)) add(alt, c);
    }
    return this.cities.size;
  }

  /** Places named in free text. With GeoNames loaded this is an n-gram lookup, not a scan of the gazetteer. */
  fromText(text: string): Place[] {
    if (!this.cities.size) return [];
    const toks = tokens(text);
    const found = new Map<string, Place>();
    for (let i = 0; i < toks.length; i++)
      for (let len = Math.min(this.maxTokens, toks.length - i); len >= 1; len--) {
        const key = toks.slice(i, i + len).join(' ');
        const c = this.cities.get(key);
        if (!c) continue;
        // A lower-case Latin word that happens to be a town ("nice", "mobile", "reading") is not a place reference.
        if (LATIN.test(key) && !new RegExp(`(?<![\\p{L}])${key.split(' ').map(w => `[${w[0]!.toUpperCase()}]${w.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join('\\s+')}`, 'u').test(canonicalCase(text))) continue;
        // The matched spelling is kept as an alias, so the core finds this place in the same text (any script).
        found.set(c.name, { ...boxAround(c.name, c.lat, c.lon, c.population), aliases: [key] });
        i += len - 1;
        break;
      }
    return [...found.values()];
  }

  /**
   * Places for an item: an explicit place claim is resolved first (GeoNames, then the fallback gazetteer, then
   * Nominatim with caching); otherwise places named in the text.
   */
  async resolve(text: string, claimedPlace?: string): Promise<Place[]> {
    const { findPlaces } = await import('admiralty-gate');
    if (claimedPlace) {
      const local = [...this.fromText(claimedPlace), ...findPlaces(claimedPlace, this.o.fallback)];
      if (local.length) return dedupe(local);
      const remote = await this.nominatim(claimedPlace);
      if (remote) return [remote];
    }
    return dedupe([...this.fromText(text), ...findPlaces(text, this.o.fallback)]);
  }

  private async nominatim(query: string): Promise<Place | undefined> {
    if (!this.o.nominatimUrl) return undefined;
    const q = canonical(query).slice(0, 200);
    if (!q) return undefined;
    const cached = await this.o.cache?.getGeocode(q);
    if (cached?.hit) return cached.place;
    const wait = this.lastCall + (this.o.minIntervalMs ?? 1100) - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastCall = Date.now();
    let place: Place | undefined;
    try {
      const url = `${this.o.nominatimUrl.replace(/\/$/, '')}/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
      const res = await (this.o.fetch ?? fetch)(url, { headers: { 'user-agent': this.o.userAgent ?? 'admiralty-gate-geocoder', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return undefined; // not cached: a failure is not an answer
      const hit = ((await res.json()) as { lat?: string; lon?: string; boundingbox?: string[]; display_name?: string }[])[0];
      if (hit?.lat && hit.lon) {
        const bb = hit.boundingbox?.map(Number);
        place = bb?.length === 4 && bb.every(Number.isFinite)
          ? { name: query, bbox: [bb[2]!, bb[0]!, bb[3]!, bb[1]!] }
          : boxAround(query, Number(hit.lat), Number(hit.lon), 0);
      }
    } catch {
      return undefined;
    }
    await this.o.cache?.putGeocode(q, place);
    return place;
  }
}

/** Text with invisible characters removed but letter case kept (the capitalisation check needs it). */
function canonicalCase(text: string): string {
  return text.normalize('NFKC');
}

function dedupe(places: Place[]): Place[] {
  const seen = new Map<string, Place>();
  for (const p of places) if (!seen.has(p.name.toLowerCase())) seen.set(p.name.toLowerCase(), p);
  return [...seen.values()];
}
