'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Tables } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { photoUrl } from '@/lib/public';
import { Alert, Button, Card, Field, Input, Textarea } from '@/components/ui';

const MAX_PHOTOS = 8;
const MAX_BYTES = 3 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Public profile (/k/<slug>) and platform leads. Photos live in the public kitchen-photos bucket
// under <kitchen_id>/; only owners can add or remove them.
export function ListingForm({ kitchen }: { kitchen: Tables<'kitchens'> }) {
  const router = useRouter();
  const [f, setF] = useState({
    description: kitchen.description ?? '',
    tags: (kitchen.cuisine_tags ?? []).join(', '),
    trial_meals: String(kitchen.trial_meals),
    accepts: kitchen.accepts_platform_leads,
  });
  const [photos, setPhotos] = useState<string[]>(kitchen.photo_paths ?? []);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const isListed = kitchen.status === 'active';

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const tags = [...new Set(f.tags.split(',').map((t) => t.trim()).filter(Boolean))];
    if (tags.length > 10) return setMsg({ tone: 'red', text: 'Use at most 10 tags.' });
    const trial = Number(f.trial_meals);
    if (!Number.isInteger(trial) || trial < 1 || trial > 7) return setMsg({ tone: 'red', text: 'Trial meals must be between 1 and 7.' });
    setBusy(true);
    const { error } = await supabaseBrowser().from('kitchens').update({
      description: f.description.trim() || null, cuisine_tags: tags, trial_meals: trial, accepts_platform_leads: f.accepts,
    }).eq('id', kitchen.id);
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Profile saved.' });
    router.refresh();
  }

  async function savePhotos(next: string[]) {
    const { error } = await supabaseBrowser().from('kitchens').update({ photo_paths: next }).eq('id', kitchen.id);
    if (error) throw error;
    setPhotos(next);
  }

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setMsg(null);
    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) return setMsg({ tone: 'red', text: `You can add ${room} more photo${room === 1 ? '' : 's'} (up to ${MAX_PHOTOS}).` });
    const bad = files.find((file) => !TYPES[file.type] || file.size > MAX_BYTES);
    if (bad) return setMsg({ tone: 'red', text: `${bad.name}: use a JPG, PNG or WebP photo under 3 MB.` });
    setUploading(true);
    const supabase = supabaseBrowser();
    const added: string[] = [];
    try {
      for (const file of files) {
        const path = `${kitchen.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${TYPES[file.type]}`;
        const { error } = await supabase.storage.from('kitchen-photos').upload(path, file, { contentType: file.type, upsert: false });
        if (error) throw error;
        added.push(path);
      }
      await savePhotos([...photos, ...added]);
      setMsg({ tone: 'green', text: added.length === 1 ? 'Photo added.' : `${added.length} photos added.` });
      router.refresh();
    } catch (err) {
      if (added.length) await supabase.storage.from('kitchen-photos').remove(added);
      setMsg({ tone: 'red', text: friendlyError(err as { message?: string }) });
    } finally {
      setUploading(false);
    }
  }

  async function remove(path: string) {
    setMsg(null);
    try {
      await savePhotos(photos.filter((p) => p !== path));
      await supabaseBrowser().storage.from('kitchen-photos').remove([path]);
      router.refresh();
    } catch (err) {
      setMsg({ tone: 'red', text: friendlyError(err as { message?: string }) });
    }
  }

  async function move(i: number) {
    if (i === 0) return;
    const next = [...photos];
    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
    try {
      await savePhotos(next);
    } catch (err) {
      setMsg({ tone: 'red', text: friendlyError(err as { message?: string }) });
    }
  }

  return (
    <div id="listing" className="mb-6 scroll-mt-4">
      <Card
        title="Profile & listing"
        actions={isListed
          ? <a href={`/k/${kitchen.slug}`} target="_blank" rel="noreferrer" className="text-sm text-brand-700 hover:underline">View public page ↗</a>
          : <span className="text-xs text-ink-500">Public page appears once your kitchen is listed</span>}
      >
        <form onSubmit={save} className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Field label="About your kitchen" hint={`${f.description.length}/1000 · What you cook, who cooks, what makes it home-style. At least 20 characters.`}>
              <Textarea rows={5} maxLength={1000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
                placeholder="Odia home food cooked fresh every day by Mrs. Sahoo. Dalma, santula, fish curry on Sundays…" />
            </Field>
            <Field label="Cuisine tags" hint="Comma separated, up to 10. e.g. Odia, Home-style, North Indian">
              <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 items-end gap-4">
              <Field label="Trial meals" hint="New customers pay for these first (1–7).">
                <Input type="number" min={1} max={7} inputMode="numeric" value={f.trial_meals} onChange={(e) => setF({ ...f, trial_meals: e.target.value })} />
              </Field>
              <label className="flex items-start gap-2 pb-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={f.accepts} onChange={(e) => setF({ ...f, accepts: e.target.checked })} />
                <span>Send me new customers from the platform</span>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</Button>
              {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-ink-700">Photos ({photos.length}/{MAX_PHOTOS})</span>
              {photos.length < MAX_PHOTOS && (
                <label className={`cursor-pointer rounded-lg bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-ink-200 hover:bg-ink-50 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
                  {uploading ? 'Uploading…' : 'Add photos'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={upload} disabled={uploading} />
                </label>
              )}
            </div>
            {photos.length ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {photos.map((p, i) => (
                  <li key={p} className="group relative overflow-hidden rounded-lg ring-1 ring-ink-100">
                    {/* eslint-disable-next-line @next/next/no-img-element -- user uploads from the public bucket */}
                    <img src={photoUrl(p)} alt={`Photo ${i + 1}`} className="aspect-[4/3] w-full object-cover" />
                    {i === 0 && <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white">Cover</span>}
                    <div className="absolute inset-x-1 bottom-1 flex justify-end gap-1">
                      {i > 0 && <button type="button" onClick={() => move(i)} className="rounded bg-white/90 px-1.5 text-xs text-ink-800 shadow">◀ Move</button>}
                      <button type="button" onClick={() => remove(p)} className="rounded bg-white/90 px-1.5 text-xs text-red-700 shadow">Remove</button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg bg-ink-50 p-4 text-sm text-ink-500">
                Add photos of your food, your kitchen and your tiffin boxes. Kitchens with photos get picked more often. JPG, PNG or WebP, up to 3 MB each.
              </p>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
