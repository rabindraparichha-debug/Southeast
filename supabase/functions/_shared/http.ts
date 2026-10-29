// Small HTTP helpers for the Edge Functions (no external imports).

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Calls a Postgres function through PostgREST, either as the caller (their JWT) or as the service role. */
export async function rpc<T>(
  supabaseUrl: string,
  apiKey: string,
  bearer: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string; code?: string } | null }> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: apiKey, Authorization: bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) return { data: null, error: { message: body?.message ?? res.statusText, code: body?.code } };
  return { data: body as T, error: null };
}
