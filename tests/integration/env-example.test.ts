// The Supabase CLI reads everything after "=" in supabase/functions/.env as the value, so an inline
// "# comment" becomes part of the value (CI copies .env.example to .env, and a mode like
// "mock   # local only" is then refused). Comments must sit on their own lines.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('supabase/functions/.env.example', () => {
  it('has no inline comments on assignment lines', () => {
    const text = readFileSync(new URL('../../supabase/functions/.env.example', import.meta.url), 'utf8');
    const bad = text
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^[A-Z0-9_]+=/.test(line) && /\s#/.test(line));
    expect(bad.map(({ n, line }) => `${n}: ${line}`)).toEqual([]);
  });
});
