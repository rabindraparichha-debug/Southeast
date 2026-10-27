'use client';

import 'leaflet/dist/leaflet.css';
import { CircleMarker, MapContainer, TileLayer, useMapEvents } from 'react-leaflet';
import type { LatLng } from './location-picker';

// Bhubaneswar city centre.
const DEFAULT_CENTER: LatLng = { lat: 20.2961, lng: 85.8245 };

function ClickToPin({ onChange }: { onChange: (v: LatLng) => void }) {
  useMapEvents({
    click: (e) => onChange({ lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) }),
  });
  return null;
}

export default function LocationMap({ value, onChange, center }: { value: LatLng | null; onChange: (v: LatLng) => void; center?: LatLng | null }) {
  const start = value ?? center ?? DEFAULT_CENTER;
  return (
    <MapContainer center={[start.lat, start.lng]} zoom={value ? 16 : 13} className="h-64 rounded-lg ring-1 ring-ink-200" scrollWheelZoom={false}>
      {/* OpenStreetMap tiles are for development; production map tiles/geocoding: see docs/DECISIONS.md D-013. */}
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <ClickToPin onChange={onChange} />
      {value && <CircleMarker center={[value.lat, value.lng]} radius={10} pathOptions={{ color: '#ea580c', fillOpacity: 0.6 }} />}
    </MapContainer>
  );
}
