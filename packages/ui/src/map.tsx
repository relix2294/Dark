import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Карта на Leaflet без ключей: тайлы OpenStreetMap по умолчанию, свой сервер — VITE_TILES_URL.
 * Маркеры — circleMarker/divIcon, без картинок (сборщик не ломает пути к иконкам Leaflet).
 * Полигоны — в формате зон доставки: [lon, lat][].
 */
export type MapPoint = { lat: number; lon: number };
export type MapMarker = MapPoint & { id: string; color: string; label?: string; radius?: number; title?: string };
export type MapPolygon = { id: string; points: [number, number][]; color: string; dashed?: boolean };

const TILES = (import.meta.env['VITE_TILES_URL'] as string | undefined) ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© участники OpenStreetMap';

export function MapView({
  center,
  zoom = 14,
  markers = [],
  polygons = [],
  onClick,
  height = 320,
  fit = false,
}: {
  center: MapPoint;
  zoom?: number;
  markers?: MapMarker[];
  polygons?: MapPolygon[];
  onClick?: (p: MapPoint) => void;
  height?: number | string;
  /** Подогнать масштаб под все маркеры и полигоны при изменении. */
  fit?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lon], zoom);
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => clickRef.current?.({ lat: e.latlng.lat, lon: e.latlng.lng }));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // карта создаётся один раз; центр меняется отдельным эффектом
  }, []);

  useEffect(() => {
    if (!fit) map.current?.setView([center.lat, center.lon], map.current.getZoom());
  }, [center.lat, center.lon, fit]);

  useEffect(() => {
    const g = layer.current;
    if (!g || !map.current) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    for (const p of polygons) {
      const latlngs = p.points.map(([lon, lat]) => [lat, lon] as [number, number]);
      bounds.push(...latlngs);
      L.polygon(latlngs, { color: p.color, weight: 2, fillOpacity: 0.12, ...(p.dashed ? { dashArray: '6 6' } : {}) }).addTo(g);
    }
    for (const mk of markers) {
      bounds.push([mk.lat, mk.lon]);
      if (mk.label) {
        L.marker([mk.lat, mk.lon], {
          icon: L.divIcon({ className: 'map-label', html: `<span style="background:${mk.color}">${escapeHtml(mk.label)}</span>`, iconSize: undefined }),
          ...(mk.title ? { title: mk.title } : {}),
        }).addTo(g);
      } else {
        L.circleMarker([mk.lat, mk.lon], { radius: mk.radius ?? 8, color: '#fff', weight: 2, fillColor: mk.color, fillOpacity: 1 })
          .bindTooltip(mk.title ?? '')
          .addTo(g);
      }
    }
    if (fit && bounds.length > 1) map.current.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 16 });
  }, [markers, polygons, fit]);

  return <div ref={el} className="map" style={{ height }} />;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
