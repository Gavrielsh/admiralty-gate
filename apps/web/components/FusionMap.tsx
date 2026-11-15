'use client';

import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap, MapLayerMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { STATUS, type HeatCollection, type IncidentCollection } from '@/lib/api';

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/**
 * Offline base map: country outlines from the bundled Natural Earth data (world-atlas), drawn as two layers. No tile
 * server is contacted. Set NEXT_PUBLIC_MAP_STYLE_URL to a MapLibre style to use real tiles instead.
 */
const BASE: StyleSpecification = {
  version: 8,
  sources: { land: { type: 'geojson', data: EMPTY } },
  layers: [
    { id: 'sea', type: 'background', paint: { 'background-color': '#070b11' } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#121a24' } },
    { id: 'borders', type: 'line', source: 'land', paint: { 'line-color': '#2a394b', 'line-width': 0.7 } },
  ],
};

export interface FusionMapProps {
  incidents: IncidentCollection | null;
  heat: HeatCollection | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onBounds?: (bbox: [number, number, number, number]) => void;
  /** Told which base map ended up in use: the street style, or the bundled outlines (with the reason, if it was a fallback). */
  onBase?: (base: { kind: 'street' | 'outlines'; note?: string }) => void;
}

/** Fetch the street style first, with a short timeout, so that an unreachable tile host falls back cleanly. */
async function loadStyle(url: string): Promise<StyleSpecification> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const style = (await res.json()) as StyleSpecification;
  if (style.version !== 8 || !Array.isArray(style.layers)) throw new Error('not a MapLibre style');
  return style;
}

export default function FusionMap({ incidents, heat, selected, onSelect, onBounds, onBase }: FusionMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ incidents, heat, selected, onSelect, onBounds, onBase });
  latest.current = { incidents, heat, selected, onSelect, onBounds, onBase };

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { incidents: inc, heat: h, selected: sel } = latest.current;
    const feats = inc?.features ?? [];
    (m.getSource('incidents') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats.filter(f => f.geometry.type === 'Point') } as never);
    (m.getSource('links') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats.filter(f => f.geometry.type === 'LineString') } as never);
    (m.getSource('heat') as GeoJSONSource).setData((h ?? EMPTY) as never);
    m.setFilter('incident-selected', ['==', ['get', 'id'], sel ?? '']);
    const max = Math.max(1, h?.meta.max ?? 1);
    m.setPaintProperty('heat', 'heatmap-weight', ['interpolate', ['linear'], ['get', 'count'], 0, 0, max, 1]);
  };

  useEffect(() => {
    if (!el.current) return;
    let cancelled = false;
    let m: MlMap | undefined;
    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    // Served from public/ (copied there by scripts/copy-map-worker.mjs).
    maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
    (async () => {
      let style: StyleSpecification = BASE;
      let street = false;
      if (styleUrl) {
        try {
          style = await loadStyle(styleUrl);
          street = true;
        } catch (e) {
          latest.current.onBase?.({ kind: 'outlines', note: `street map unreachable (${(e as Error).message}); showing bundled outlines` });
        }
      }
      if (!styleUrl) latest.current.onBase?.({ kind: 'outlines' });
      if (street) latest.current.onBase?.({ kind: 'street' });
      if (cancelled || !el.current) return;
      m = build(el.current, style, street);
    })();
    return () => {
      cancelled = true;
      ready.current = false;
      m?.remove();
      map.current = null;
    };
    // The map is created once; data flows in through `push`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const build = (container: HTMLDivElement, style: StyleSpecification, street: boolean): MlMap => {
    const m = new maplibregl.Map({ container, style, center: [33.6, 33.6], zoom: 5.4, attributionControl: false, maxZoom: street ? 18 : 14 });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.AttributionControl({ compact: true, ...(street ? {} : { customAttribution: 'Outlines: Natural Earth' }) }));
    m.on('load', async () => {
      if (!street) {
        const [{ feature }, topo] = await Promise.all([import('topojson-client'), import('world-atlas/countries-50m.json')]);
        const t = (topo as unknown as { default: never }).default;
        (m.getSource('land') as GeoJSONSource | undefined)?.setData(feature(t, (t as { objects: { countries: never } }).objects.countries) as never);
      }
      m.addSource('heat', { type: 'geojson', data: EMPTY });
      m.addSource('links', { type: 'geojson', data: EMPTY });
      m.addSource('incidents', { type: 'geojson', data: EMPTY });
      // Heat: one hue, transparent to bright, so it reads as density and never competes with the status colours.
      m.addLayer({ id: 'heat', type: 'heatmap', source: 'heat', paint: {
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 14, 9, 34, 12, 60],
        'heatmap-intensity': 1.1,
        'heatmap-opacity': 0.75,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(57,135,229,0)', 0.25, 'rgba(28,92,171,0.55)', 0.6, 'rgba(57,135,229,0.8)', 1, 'rgba(183,211,246,0.95)'],
      } });
      m.addLayer({ id: 'links', type: 'line', source: 'links', paint: { 'line-color': STATUS.ring.color, 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } });
      const radius: ExpressionSpecification = ['interpolate', ['linear'], ['get', 'rawItems'], 1, 7, 10, 12, 40, 18];
      // Shape as well as colour: released = filled, quarantined = hollow, ring = filled with a wide halo.
      m.addLayer({ id: 'incident-halo', type: 'circle', source: 'incidents', filter: ['==', ['get', 'status'], 'ring'], paint: { 'circle-radius': ['+', radius, 7], 'circle-color': STATUS.ring.color, 'circle-opacity': 0.18 } });
      m.addLayer({ id: 'incidents', type: 'circle', source: 'incidents', paint: {
        'circle-radius': radius,
        'circle-color': ['match', ['get', 'status'], 'released', STATUS.released.color, 'ring', STATUS.ring.color, '#0f141b'],
        'circle-stroke-color': ['match', ['get', 'status'], 'released', '#0f141b', 'quarantined', STATUS.quarantined.color, '#0f141b'],
        'circle-stroke-width': ['match', ['get', 'status'], 'quarantined', 3, 2],
      } });
      m.addLayer({ id: 'incident-selected', type: 'circle', source: 'incidents', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': ['+', radius, 6], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#e6edf5', 'circle-stroke-width': 2 } });
      m.on('click', 'incidents', (e: MapLayerMouseEvent) => latest.current.onSelect((e.features?.[0]?.properties as { id?: string } | undefined)?.id ?? null));
      m.on('mouseenter', 'incidents', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'incidents', () => (m.getCanvas().style.cursor = ''));
      const bounds = () => {
        const b = m.getBounds();
        latest.current.onBounds?.([Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()), Math.min(180, b.getEast()), Math.min(90, b.getNorth())]);
      };
      m.on('moveend', bounds);
      ready.current = true;
      bounds();
      push();
    });
    return m;
  };

  useEffect(push, [incidents, heat, selected]);

  useEffect(() => {
    const f = incidents?.features.find(x => x.geometry.type === 'Point' && (x.properties as { id?: string }).id === selected);
    if (f && map.current) map.current.easeTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.current.getZoom(), 7.5), duration: 600 });
  }, [selected, incidents]);

  return <div ref={el} className="h-full w-full" role="application" aria-label="Fusion map: incidents, ring links and event heatmap" />;
}
