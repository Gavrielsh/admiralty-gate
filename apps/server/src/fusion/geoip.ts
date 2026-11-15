import { existsSync, readFileSync } from 'node:fs';
import type { GeoPoint } from 'admiralty-gate';

/**
 * Offline IP geolocation from an operator-supplied CSV (`cidr,lat,lon[,label]`, IPv4). No data is bundled and no
 * service is called: point GEOIP_CSV at an export of whatever GeoIP database you are licensed to use.
 */
export class GeoIpTable {
  private readonly rows: { net: number; mask: number; bits: number; point: GeoPoint; label?: string }[] = [];

  static fromFile(path: string | undefined): GeoIpTable {
    const t = new GeoIpTable();
    if (path && existsSync(path)) t.load(readFileSync(path, 'utf8'));
    return t;
  }

  load(csv: string): number {
    for (const line of csv.split('\n')) {
      const [cidr, lat, lon, label] = line.split(',').map(s => s.trim());
      if (!cidr || cidr.startsWith('#')) continue;
      const [ip, bitsRaw] = cidr.split('/');
      const n = ipToInt(ip ?? '');
      const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
      const point = { lat: Number(lat), lon: Number(lon) };
      if (n === null || !Number.isInteger(bits) || bits < 0 || bits > 32 || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      this.rows.push({ net: (n & mask) >>> 0, mask, bits, point, ...(label ? { label } : {}) });
    }
    // Longest prefix first, so the most specific range wins.
    this.rows.sort((a, b) => b.bits - a.bits);
    return this.rows.length;
  }

  get size(): number {
    return this.rows.length;
  }

  lookup(ip: string): GeoPoint | undefined {
    const n = ipToInt(ip);
    if (n === null) return undefined;
    return this.rows.find(r => ((n & r.mask) >>> 0) === r.net)?.point;
  }
}

function ipToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n >>> 0;
}
