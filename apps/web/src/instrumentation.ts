import type { Instrumentation } from 'next';
import { reportError } from '@/lib/monitor';

// Server-side errors (Server Components, route handlers, server actions, proxy) go to Sentry when
// NEXT_PUBLIC_SENTRY_DSN is set (D-092). Only the route and request method are sent, never headers
// or cookies; reportError masks phone numbers and customer-page tokens.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  await reportError(error, {
    source: 'server',
    tags: {
      route: context.routePath,
      route_type: context.routeType,
      router: context.routerKind,
      method: request.method,
      runtime: process.env.NEXT_RUNTIME ?? 'nodejs',
    },
    extra: { path: request.path.split('?')[0], render_source: 'renderSource' in context ? context.renderSource : undefined },
  });
};
