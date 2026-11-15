/**
 * A synthetic scenario for the workbench. Everything in it is invented: place names are real, the events are not;
 * addresses come from the documentation ranges (RFC 5737), domains end in .example, wallets are made-up strings.
 */
import type { LedgerEvent, RawItem } from './service.js';

const MIN = 60_000;
const W = (n: number): string => `0x${n.toString(16).padStart(2, '0').repeat(20)}`;

/** `cidr,lat,lon,label` rows that give the documentation ranges a pretend location, so the IP check has something to say. */
export const DEMO_GEOIP = ['203.0.113.0/24,50.11,8.68,demo-vpn-exit', '198.51.100.0/24,34.68,33.04,demo-limassol-isp', '192.0.2.0/24,35.17,33.36,demo-nicosia-isp'].join('\n');

export function demoItems(now: number): RawItem[] {
  const strike = 'limassol-port-strike';
  const refinery = 'haifa-refinery-explosion';
  const echo = 'Dock workers at Limassol port began an indefinite strike on Monday over pay, the union said.';
  // Paraphrased on purpose: text similarity alone does not catch this network. The shared hub and the timing do.
  const rumours = [
    'URGENT: massive explosion at the Haifa refinery, dozens of casualties, share before it gets deleted',
    'Huge blast just now at the refinery in Haifa. Many injured. They are hiding it!',
    'Eyewitness: flames over Haifa refinery after a giant explosion, hospitals overwhelmed',
    'Confirmed by our sources: Haifa refinery destroyed in explosion, authorities silent',
    'Explosion rocks Haifa oil refinery; casualty numbers being covered up, spread the word',
    'BREAKING Haifa: refinery explosion, dozens dead according to locals, media blackout',
  ];
  return [
    // 1. A real-looking event: two independent, well-graded origins, plus a crowd of channels forwarding one of them.
    { claim: strike, sourceType: 'feed', sourceId: 'wire-service', grade: 'B2', at: now - 190 * MIN, text: echo, geo: { lat: 34.6501, lon: 33.0172 } },
    { claim: strike, sourceType: 'web', sourceId: 'ports-authority.example', grade: 'A2', at: now - 170 * MIN, text: 'Cyprus ports authority confirms cargo handling at Limassol is suspended; 14 vessels are waiting at anchor at 34.6460, 33.0190.' },
    ...[1, 2, 3, 4, 5].map<RawItem>(i => ({
      claim: strike, sourceType: 'telegram', sourceId: `channel-${i}`, owner: 'tg:wire-forwards', grade: 'D3', at: now - (185 - i) * MIN,
      text: `${echo} Via wire. (${i})`, externalId: `strike-${i}`,
    })),
    // 2. A manufactured story: six channels, one hub, posted inside two minutes, coordinates that are nowhere near Haifa.
    ...[1, 2, 3, 4, 5, 6].map<RawItem>(i => ({
      claim: refinery, sourceType: 'telegram', sourceId: `amp-channel-${i}`, grade: i < 3 ? 'D3' : 'E4', at: now - 95 * MIN + i * 15_000,
      text: rumours[i - 1]!, externalId: `rumour-${i}`, claimedPlace: 'Haifa',
      indicators: [{ kind: 'telegram', value: 'amplifier_hub' }],
      ...(i === 1 ? { geo: { lat: 55.7512, lon: 37.6184 } } : {}),
    })),
    { claim: refinery, stance: 'contradicts', sourceType: 'web', sourceId: 'fire-service.example', grade: 'A2', at: now - 80 * MIN, text: 'The fire and rescue service reports no incident at the Haifa refinery today.', claimedPlace: 'Haifa' },
    // 3. Plausible but thin: one decent source. Held until someone else confirms.
    { claim: 'red-sea-vessel-incident', sourceType: 'feed', sourceId: 'maritime-bulletin', grade: 'B2', at: now - 40 * MIN, text: 'A bulk carrier reported a near miss in the southern Red Sea at 14.52, 42.31; no damage, crew safe.' },
    // 4. Graded but unattached reporting, for the provenance browser.
    { sourceType: 'feed', sourceId: 'cert-advisory', grade: 'A2', at: now - 300 * MIN, text: 'Advisory: phishing panel at login.shady-pay.example reached from 203.0.113.9 (AS64500).' },
  ];
}

export function demoLedger(now: number): LedgerEvent[] {
  const limassol = { lat: 34.6786, lon: 33.0413 };
  const nicosia = { lat: 35.1725, lon: 33.365 };
  const larnaca = { lat: 34.9182, lon: 33.6201 };
  const paphos = { lat: 34.7754, lon: 32.4245 };
  const j = (p: { lat: number; lon: number }, n: number) => ({ lat: Number((p.lat + ((n * 37) % 11) * 0.002).toFixed(5)), lon: Number((p.lon + ((n * 53) % 13) * 0.002).toFixed(5)) });
  const ev: LedgerEvent[] = [];
  // Ring A: seven accounts cashing out to two wallets from three devices; some through a VPN exit.
  const ringA = [
    ['acct-1001', W(0xa1), 'fp-7f3a', limassol, false], ['acct-1002', W(0xa1), 'fp-7f3a', limassol, false], ['acct-1003', W(0xa1), 'fp-19c2', nicosia, false],
    ['acct-1004', W(0xa2), 'fp-19c2', nicosia, true], ['acct-1005', W(0xa2), 'fp-4d10', larnaca, true], ['acct-1006', W(0xa2), 'fp-4d10', larnaca, false],
    ['acct-1007', W(0xa1), 'fp-4d10', limassol, true],
  ] as const;
  ringA.forEach(([account, wallet, device, at, proxy], i) => {
    const p = j(at, i);
    ev.push({ id: `evt-a${i}`, account, wallet, device, proxy, ip: proxy ? `203.0.113.${10 + i}` : `198.51.100.${20 + i}`, asn: proxy ? '64500' : '64501', amount: 390 + i * 5, at: now - 60 * MIN + i * 40_000, ...p });
  });
  // Ring B: four accounts on one device in Paphos.
  [0, 1, 2, 3].forEach(i => {
    const p = j(paphos, i);
    ev.push({ id: `evt-b${i}`, account: `acct-20${i}`, wallet: W(0xb0 + i), device: 'fp-ee01', proxy: false, ip: `192.0.2.${40 + i}`, asn: '64502', amount: 120, at: now - 30 * MIN + i * 90_000, ...p });
  });
  // Two accounts sharing a device: below the ring threshold, so not reported.
  [0, 1].forEach(i => ev.push({ id: `evt-c${i}`, account: `acct-30${i}`, device: 'fp-0c0c', proxy: false, ip: `192.0.2.${70 + i}`, amount: 45, at: now - 20 * MIN, ...j(nicosia, 5 + i) }));
  // Ordinary traffic.
  [limassol, nicosia, larnaca, paphos, limassol, nicosia].forEach((p, i) =>
    ev.push({ id: `evt-n${i}`, account: `acct-90${i}`, wallet: W(0xc0 + i), device: `fp-n${i}`, proxy: i === 4, ip: i === 4 ? '203.0.113.200' : `198.51.100.${100 + i}`, amount: 30 + i, at: now - (240 - i * 20) * MIN, ...j(p, 9 + i) }));
  return ev;
}
