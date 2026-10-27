'use client';

import dynamic from 'next/dynamic';

export type LatLng = { lat: number; lng: number };

// Leaflet touches `window`, so the map only renders in the browser.
const Map = dynamic(() => import('./location-map'), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-lg bg-ink-100" />,
});

export function LocationPicker(props: { value: LatLng | null; onChange: (v: LatLng) => void; center?: LatLng | null }) {
  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition((pos) =>
      props.onChange({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) }),
    );
  }
  return (
    <div className="space-y-2">
      <Map {...props} />
      <div className="flex items-center justify-between text-xs text-ink-500">
        <span>{props.value ? `Pin: ${props.value.lat.toFixed(5)}, ${props.value.lng.toFixed(5)}` : 'Tap the map to drop the delivery pin'}</span>
        <button type="button" onClick={useMyLocation} className="font-medium text-brand-700 hover:underline">
          Use my location
        </button>
      </div>
    </div>
  );
}
