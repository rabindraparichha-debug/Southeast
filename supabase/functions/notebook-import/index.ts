// Notebook-photo import (P6). The signed-in owner uploads a photo of their paper register to the
// private 'imports' bucket (imports/<kitchen_id>/...) and calls this function with its path.
// Claude reads the rows (vision, structured output); _shared/notebook.ts validates them. It returns
// a PREVIEW only: nothing is written. The owner confirms through the existing import_customers RPC.
// Without ANTHROPIC_API_KEY (or with NOTEBOOK_IMPORT_MODE=mock) a fixture answer is used.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { buildPreview, MOCK_MODEL_OUTPUT, NOTEBOOK_SCHEMA, notebookPrompt, parseModelOutput } from '../_shared/notebook.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const env = (k: string) => Deno.env.get(k);
const monitor = loadMonitorConfig(env);

const MEDIA: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readWithClaude(image: Uint8Array, mediaType: string, plans: string[]): Promise<string> {
  const { default: Anthropic } = await import('npm:@anthropic-ai/sdk@0.137.0');
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  const res = await client.messages.create({
    model: env('ANTHROPIC_MODEL') ?? 'claude-opus-5-5',
    max_tokens: 8000,
    output_config: { format: { type: 'json_schema', schema: NOTEBOOK_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: toBase64(image) } },
        { type: 'text', text: notebookPrompt(plans) },
      ],
    }],
  } as never) as { stop_reason: string; content: { type: string; text?: string }[] };
  if (res.stop_reason === 'refusal') throw new Error('model_refused');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('unreadable_output');
  return text;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'not_authenticated' }, 401);
  const { kitchen_id, path } = await req.json().catch(() => ({})) as { kitchen_id?: string; path?: string };

  // As the caller: owner of the kitchen, photo inside the kitchen's folder.
  const ctx = await rpc<{ kitchen_name: string; plans: string[] }>(SUPABASE_URL, ANON_KEY, auth, 'notebook_import_context',
    { p_kitchen: kitchen_id ?? null, p_path: path ?? null });
  if (ctx.error || !ctx.data) return json({ error: ctx.error?.message ?? 'forbidden' }, 400);

  const mode = !env('ANTHROPIC_API_KEY') || env('NOTEBOOK_IMPORT_MODE') === 'mock' ? 'mock' : 'live';
  try {
    let output: string;
    if (mode === 'mock') {
      output = MOCK_MODEL_OUTPUT;
    } else {
      const file = await fetch(`${SUPABASE_URL}/storage/v1/object/imports/${path!.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
      });
      if (!file.ok) return json({ error: 'photo_not_found' }, 404);
      const ext = path!.split('.').pop()?.toLowerCase() ?? '';
      const mediaType = file.headers.get('content-type')?.split(';')[0] || MEDIA[ext] || 'image/jpeg';
      output = await readWithClaude(new Uint8Array(await file.arrayBuffer()), mediaType, ctx.data.plans);
    }
    const preview = buildPreview(parseModelOutput(output), { plans: ctx.data.plans });
    return json({ mode, path, ...preview });
  } catch (e) {
    const code = String((e as Error).message);
    if (code === 'unreadable_output' || code === 'model_refused') return json({ error: code }, 422);
    await reportError(monitor, e, { fn: 'notebook-import' });
    return json({ error: 'ai_error' }, 502);
  }
});
