'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input } from '@/components/ui';

type Values = { version: string; android_url: string; ios_url: string; message: string };

export function MinVersionForm({ initial }: { initial: Values }) {
  const router = useRouter();
  const [v, setV] = useState<Values>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  async function save(e: FormEvent, clear = false) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('admin_set_min_app_version', {
      p_version: clear ? '' : v.version.trim(),
      p_android_url: v.android_url.trim() || undefined,
      p_ios_url: v.ios_url.trim() || undefined,
      p_message: v.message.trim() || undefined,
    });
    setBusy(false);
    setMsg(error ? { tone: 'red', text: friendlyError(error) } : { tone: 'green', text: clear || !v.version.trim() ? 'No minimum version now.' : `Version ${v.version.trim()} is now required.` });
    if (!error && clear) setV({ ...v, version: '' });
    router.refresh();
  }

  return (
    <form onSubmit={(e) => save(e)} className="mt-4 space-y-3">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Field label="Minimum version" hint="As in apps/mobile/app.json, e.g. 1.2.0. Empty = no minimum.">
        <Input value={v.version} onChange={(e) => setV({ ...v, version: e.target.value })} placeholder="1.2.0" className="max-w-40" />
      </Field>
      <Field label="Android download link" hint="https:// link to the new APK or the Play Store page.">
        <Input value={v.android_url} onChange={(e) => setV({ ...v, android_url: e.target.value })} placeholder="https://" />
      </Field>
      <Field label="iPhone download link" hint="https:// link to TestFlight or the App Store page.">
        <Input value={v.ios_url} onChange={(e) => setV({ ...v, ios_url: e.target.value })} placeholder="https://" />
      </Field>
      <Field label="Message (optional)" hint="Shown on the update screen instead of the default text.">
        <Input value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} maxLength={300} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>Save</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={(e) => save(e, true)}>Remove the minimum</Button>
      </div>
    </form>
  );
}
