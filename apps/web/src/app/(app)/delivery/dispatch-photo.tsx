'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { downscaleJpeg } from '@/lib/image';
import { formatIstTime } from '@/lib/delivery';
import { uuid } from '@/lib/rider-store';
import { Alert, Button, Card, Select } from '@/components/ui';

export type DispatchPhoto = { id: string; run_id: string | null; photo_path: string; taken_at: string };

// Packed-meals photo before dispatch (P5). Proof of what left the kitchen, and the "prepared" time
// the late-delivery alert counts from. Stored in the private 'dispatch' bucket: <kitchen_id>/<date>/...
export function DispatchPhotoCard({ kitchenId, date, slot, runs, photos }: {
  kitchenId: string; date: string; slot: MealSlot; runs: { id: string; route_name: string }[]; photos: DispatchPhoto[];
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [runId, setRunId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!photos.length) return;
    let alive = true;
    void supabaseBrowser().storage.from('dispatch').createSignedUrls(photos.map((p) => p.photo_path), 600).then(({ data }) => {
      if (!alive || !data) return;
      const next: Record<string, string> = {};
      for (const d of data) if (d.path && d.signedUrl) next[d.path] = d.signedUrl;
      setUrls(next);
    });
    return () => {
      alive = false;
    };
  }, [photos]);

  async function onFile(file: File | undefined) {
    if (input.current) input.current.value = '';
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const jpeg = await downscaleJpeg(file, 1600, 0.75);
      const path = `${kitchenId}/${date}/${slot}-${runId || 'all'}-${uuid().slice(0, 8)}.jpg`;
      const supabase = supabaseBrowser();
      const up = await supabase.storage.from('dispatch').upload(path, jpeg, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      const { error } = await supabase.rpc('record_dispatch_photo', {
        p_kitchen: kitchenId, p_date: date, p_slot: slot, p_photo_path: path, p_at: new Date().toISOString(), ...(runId ? { p_run: runId } : {}),
      });
      if (error) throw error;
      setMsg({ tone: 'green', text: 'Photo saved. The late-delivery timer starts from the first photo.' });
      router.refresh();
    } catch (e) {
      const err = e as { message?: string; code?: string };
      setMsg({ tone: 'red', text: err.message === 'invalid_photo' ? friendlyError({ message: 'photo_failed' }) : friendlyError(err) });
    } finally {
      setBusy(false);
    }
  }

  const routeName = (id: string | null) => (id ? runs.find((r) => r.id === id)?.route_name ?? 'Route' : 'Whole meal');

  return (
    <Card title="Packed-meals photo" className="mb-6" actions={photos.length ? <span className="text-xs text-ink-500">{photos.length} photo{photos.length === 1 ? '' : 's'}</span> : null}>
      <p className="text-sm text-ink-600">Take one photo of the packed tiffins before they leave. It is your proof if a customer says something was missing.</p>
      {photos.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-3">
          {photos.map((p) => (
            <li key={p.id} className="w-28 text-xs text-ink-600">
              {urls[p.photo_path] ? (
                <a href={urls[p.photo_path]} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage */}
                  <img src={urls[p.photo_path]} alt={`Packed meals, ${routeName(p.run_id)}`} className="h-20 w-28 rounded-lg object-cover ring-1 ring-ink-200" />
                </a>
              ) : (
                <div className="h-20 w-28 animate-pulse rounded-lg bg-ink-100" />
              )}
              <div className="mt-1 truncate">{routeName(p.run_id)} · {formatIstTime(p.taken_at)}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {runs.length > 1 && (
          <Select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Photo for" className="w-auto">
            <option value="">Whole meal</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.route_name}</option>)}
          </Select>
        )}
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="dispatch-input" />
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Uploading…' : '📷 Take photo'}</Button>
      </div>
      {msg && <div className="mt-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
    </Card>
  );
}
