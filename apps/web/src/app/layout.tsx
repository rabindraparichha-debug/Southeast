import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ClientMonitor } from '@/components/client-monitor';
import { INSTALL_CAPTURE_SCRIPT, ServiceWorkerRegister } from '@/components/pwa';

export const metadata: Metadata = {
  title: 'Tiffin OS',
  description: 'Free operating system for tiffin vendors',
  applicationName: 'Tiffin OS',
  appleWebApp: { capable: true, title: 'Tiffin OS', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#EA580C', viewportFit: 'cover' };

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: INSTALL_CAPTURE_SCRIPT }} />
      </head>
      <body className="min-h-full font-sans">
        <ClientMonitor />
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
