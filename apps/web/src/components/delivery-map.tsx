'use client';

import 'leaflet/dist/leaflet.css';
import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet';

export type MapStop = { id: string; lat: number; lng: number; label: string; status: 'pending' | 'delivered' | 'failed' };
export type MapRider = { id: string; lat: number; lng: number; label: string };
export type MapPoint = { lat: number; lng: number };

// Bhubaneswar city centre.
const DEFAULT_CENTER: MapPoint = { lat: 20.2961, lng: 85.8245 };
const STOP_COLOR = { pending: '#64748b', delivered: '#16a34a', failed: '#dc2626' } as const;

/** Stops (coloured by status), the kitchen and each rider's last known location. */
export default function DeliveryMap({ kitchen, stops, riders }: { kitchen: MapPoint | null; stops: MapStop[]; riders: MapRider[] }) {
  const pts: MapPoint[] = [...(kitchen ? [kitchen] : []), ...stops, ...riders];
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const bounds: [[number, number], [number, number]] | undefined =
    pts.length >= 2 ? [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]] : undefined;
  const center = pts[0] ?? DEFAULT_CENTER;

  return (
    <MapContainer
      {...(bounds ? { bounds, boundsOptions: { padding: [24, 24] } } : { center: [center.lat, center.lng], zoom: 14 })}
      className="h-72 rounded-lg ring-1 ring-ink-200"
      scrollWheelZoom={false}
    >
      {/* OpenStreetMap tiles are for development; production map tiles: see docs/DECISIONS.md D-013. */}
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {kitchen && (
        <CircleMarker center={[kitchen.lat, kitchen.lng]} radius={9} pathOptions={{ color: '#ea580c', fillColor: '#ea580c', fillOpacity: 0.9 }}>
          <Tooltip>Kitchen</Tooltip>
        </CircleMarker>
      )}
      {stops.map((s) => (
        <CircleMarker key={s.id} center={[s.lat, s.lng]} radius={6} pathOptions={{ color: STOP_COLOR[s.status], fillOpacity: 0.7 }}>
          <Tooltip>{s.label}</Tooltip>
        </CircleMarker>
      ))}
      {riders.map((r) => (
        <CircleMarker key={r.id} center={[r.lat, r.lng]} radius={11} pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.5, weight: 3 }}>
          <Tooltip permanent direction="top">{r.label}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
