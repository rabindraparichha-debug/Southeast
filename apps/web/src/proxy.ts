import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/supabase/env';

// Public website (M7): lead form, kitchen pages, directory and the vendor sign-up need no login.
// Legal pages (M8): privacy policy and terms.
const PUBLIC_PATHS = ['/login', '/c', '/find', '/k', '/kitchens', '/vendors', '/privacy', '/terms'];

// Refreshes the Supabase session cookie on every request and sends signed-out
// users to /login. Authorization itself is enforced by RLS, not here.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!data?.claims && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // sw.js and the web app manifest must load without a session (installing and offline start).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)'],
};
