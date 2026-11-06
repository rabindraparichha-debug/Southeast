// App versions ("1.2.3", from app.json) for the minimum-version gate (platform_settings
// 'min_app_version', read through public.app_config()).

/** Numeric parts of a version; missing parts count as 0, anything non-numeric makes it invalid (null). */
export function parseVersion(v: string | null | undefined): number[] | null {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(s)) return null;
  return s.split('.').map((x) => Number(x));
}

/** -1 if a < b, 0 if equal, 1 if a > b ("1.2" equals "1.2.0"). Invalid versions sort first. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * True when this build is older than the required minimum. No minimum (null/empty) or an
 * unreadable minimum never blocks; an unreadable current version is treated as old.
 */
export function isUpdateRequired(current: string | null | undefined, minimum: string | null | undefined): boolean {
  if (!minimum || !parseVersion(minimum)) return false;
  return compareVersions(current, minimum) < 0;
}
