import type { MetadataRoute } from 'next';

// Installable web app ("Add to home screen"): vendors, staff and riders use the same site as an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Tiffin OS',
    short_name: 'Tiffin OS',
    description: 'Free operating system for tiffin vendors: customers, kitchen sheet, deliveries and stock.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f8fafc',
    theme_color: '#EA580C',
    categories: ['business', 'food', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'My stops', short_name: 'Deliver', url: '/rider', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Stock entry', short_name: 'Stock', url: '/stock-entry', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
