/**
 * Geospatial helpers: distance, coordinate extraction, and a consistency
 * check between WHERE A TEXT SAYS something happened and WHERE ITS
 * COORDINATES (or its IP geolocation) put it.
 *
 * Pure functions. Geocoding and IP geolocation need external data, so they
 * are inputs here (a gazetteer, a resolved point), never lookups.
 */
import { sanitiseUntrusted, containsRun, tokens } from './text.js';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export const validPoint = (p: GeoPoint): boolean =>
  Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

const R_KM = 6371.0088;
const rad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Decimal-degree coordinate pairs in text: "34.6786, 33.0413", "34.68N 33.04E", "-12.5 130.84".
 * Both numbers need a decimal part, so "3 4" or "14, 2026" are not read as places. Order is lat, lon.
 */
export function extractCoordinates(raw: string): GeoPoint[] {
  const text = sanitiseUntrusted(raw).clean;
  const re = /(?<![\w.])(-?\d{1,2}\.\d{1,8})\s*°?\s*([NS])?\s*[,;/\s]\s*(-?\d{1,3}\.\d{1,8})\s*°?\s*([EW])?(?![\w]|\.\d)/gi;
  const out: GeoPoint[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let lat = Number(m[1]);
    let lon = Number(m[3]);
    if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
    if (m[4]?.toUpperCase() === 'W') lon = -Math.abs(lon);
    const p = { lat, lon };
    if (validPoint(p)) out.push(p);
  }
  return out;
}

/** A named place as a coarse bounding box [minLon, minLat, maxLon, maxLat]. Boxes do not cross the antimeridian. */
export interface Place {
  name: string;
  aliases?: readonly string[];
  bbox: readonly [number, number, number, number];
}

/**
 * A small, deliberately coarse sample gazetteer (generous boxes, eastern-Mediterranean bias). It exists so the
 * check works out of the box and in tests; it is NOT a geocoder. Supply your own Place[] for real coverage.
 */
export const SAMPLE_GAZETTEER: readonly Place[] = [
  { name: 'Bay of Bengal', bbox: [80, 5, 95, 22.5] },
  { name: 'Bangladesh', bbox: [88, 20.5, 92.7, 26.7] },
  { name: 'Cyprus', aliases: ['קפריסין', 'قبرص'], bbox: [32.2, 34.5, 34.6, 35.7] },
  { name: 'Limassol', aliases: ['לימסול'], bbox: [32.9, 34.6, 33.2, 34.8] },
  { name: 'Nicosia', bbox: [33.2, 35.1, 33.5, 35.25] },
  { name: 'Israel', aliases: ['ישראל'], bbox: [34.2, 29.4, 35.9, 33.4] },
  { name: 'Haifa', aliases: ['חיפה', 'حيفا'], bbox: [34.9, 32.7, 35.15, 32.9] },
  { name: 'Tel Aviv', aliases: ['תל אביב'], bbox: [34.7, 32.0, 34.9, 32.2] },
  { name: 'Lebanon', aliases: ['לבנון', 'لبنان'], bbox: [35.1, 33.0, 36.7, 34.7] },
  { name: 'Beirut', aliases: ['ביירות', 'بيروت'], bbox: [35.4, 33.8, 35.6, 33.95] },
  { name: 'Syria', bbox: [35.6, 32.3, 42.4, 37.4] },
  { name: 'Egypt', bbox: [24.7, 22, 36.9, 31.7] },
  { name: 'Suez Canal', bbox: [32.2, 29.8, 32.7, 31.4] },
  { name: 'Turkey', bbox: [25.6, 35.8, 44.9, 42.2] },
  { name: 'Red Sea', bbox: [32.3, 12.5, 43.5, 30] },
  { name: 'Gulf of Aden', bbox: [43, 10.5, 52, 15.5] },
  { name: 'Yemen', bbox: [42.5, 12, 54.6, 19] },
  { name: 'Strait of Hormuz', bbox: [55, 25.5, 57.5, 27.5] },
  { name: 'Iran', bbox: [44, 25, 63.4, 39.8] },
  { name: 'Black Sea', bbox: [27.4, 40.9, 41.8, 46.7] },
  { name: 'Ukraine', bbox: [22.1, 44.3, 40.3, 52.4] },
  { name: 'Taiwan Strait', bbox: [117, 22, 121.5, 26] },
];

/** Tokenised names per gazetteer, built once: tokenising every name for every text dominated large runs. */
const NAME_CACHE = new WeakMap<readonly Place[], { place: Place; names: string[][] }[]>();

function namesOf(gazetteer: readonly Place[]): { place: Place; names: string[][] }[] {
  let c = NAME_CACHE.get(gazetteer);
  if (!c) {
    c = gazetteer.map(place => ({ place, names: [place.name, ...(place.aliases ?? [])].map(n => tokens(n)).filter(t => t.length > 0) }));
    NAME_CACHE.set(gazetteer, c);
  }
  return c;
}

/** Places named in a text (whole-token match on name or alias, any script). */
export function findPlaces(text: string, gazetteer: readonly Place[] = SAMPLE_GAZETTEER): Place[] {
  const hay = tokens(text);
  if (hay.length === 0) return [];
  const present = new Set(hay);
  return namesOf(gazetteer)
    .filter(e => e.names.some(n => present.has(n[0]!) && (n.length === 1 || containsRun(hay, n))))
    .map(e => e.place);
}

/** 0 when the point is inside the place's box, else the distance to the nearest point of the box. */
export function distanceToPlaceKm(p: GeoPoint, place: Place): number {
  const [minLon, minLat, maxLon, maxLat] = place.bbox;
  const nearest = { lat: Math.min(maxLat, Math.max(minLat, p.lat)), lon: Math.min(maxLon, Math.max(minLon, p.lon)) };
  return haversineKm(p, nearest);
}

export type GeoFlag =
  | { kind: 'invalid-coordinates' }
  /** The text (or the claimed place) names a location; the coordinates are far from every place it names. */
  | { kind: 'toponym-mismatch'; place: string; distanceKm: number }
  /** The claimed coordinates and the IP geolocation disagree. */
  | { kind: 'ip-geo-mismatch'; distanceKm: number };

export interface GeoCheckInput {
  point?: GeoPoint;
  /** Free text that may name places. */
  text?: string;
  /** An explicit place claim ("Bay of Bengal near Bangladesh"); checked like text, but takes precedence over it. */
  claimedPlace?: string;
  /** Where IP geolocation puts the item's producer. */
  ipGeo?: GeoPoint;
}

export interface GeoCheckOptions {
  gazetteer?: readonly Place[];
  /** Slack around a place's box before it counts as a mismatch. Default 250 km. */
  toleranceKm?: number;
  /** Allowed distance between claimed coordinates and IP geolocation. Default 500 km (IP geolocation is coarse). */
  ipToleranceKm?: number;
}

/**
 * Deterministic consistency check. A mismatch is reported only when the coordinates are outside the tolerance of
 * EVERY place named: "off Limassol, Cyprus" is consistent with a point in either box. No named place, no flag.
 */
export function checkGeoConsistency(i: GeoCheckInput, o: GeoCheckOptions = {}): GeoFlag[] {
  const flags: GeoFlag[] = [];
  if (i.point && !validPoint(i.point)) return [{ kind: 'invalid-coordinates' }];
  if (i.point) {
    const named = i.claimedPlace ? findPlaces(i.claimedPlace, o.gazetteer) : [];
    const places = named.length ? named : i.text ? findPlaces(i.text, o.gazetteer) : [];
    if (places.length) {
      const d = places.map(p => ({ p, km: distanceToPlaceKm(i.point!, p) })).sort((a, b) => a.km - b.km)[0]!;
      if (d.km > (o.toleranceKm ?? 250)) flags.push({ kind: 'toponym-mismatch', place: d.p.name, distanceKm: Math.round(d.km) });
    }
    if (i.ipGeo && validPoint(i.ipGeo)) {
      const km = haversineKm(i.point, i.ipGeo);
      if (km > (o.ipToleranceKm ?? 500)) flags.push({ kind: 'ip-geo-mismatch', distanceKm: Math.round(km) });
    }
  }
  return flags;
}
