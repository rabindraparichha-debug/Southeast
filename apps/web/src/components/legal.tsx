import Link from 'next/link';
import type { ReactNode } from 'react';

// Shared layout for the privacy policy, terms, vendor terms and data processing agreement (public
// website). Plain language, short sections.
//
// The operator and the grievance officer come from the environment (D-181), inlined at build time:
//   NEXT_PUBLIC_OPERATOR_NAME       the operator's legal name
//   NEXT_PUBLIC_OPERATOR_ADDRESS    registered address
//   NEXT_PUBLIC_GRIEVANCE_OFFICER   the grievance officer's name (DPDP)
//   NEXT_PUBLIC_GRIEVANCE_CONTACT   how to reach them (email and phone)
// A production build against a hosted Supabase project fails without the operator name and the
// grievance contact (next.config.ts with src/lib/legal-env.mjs).
export const OPERATOR = {
  name: process.env.NEXT_PUBLIC_OPERATOR_NAME?.trim() || '[Platform operator legal name]',
  brand: 'Tiffin Bhubaneswar',
  address: process.env.NEXT_PUBLIC_OPERATOR_ADDRESS?.trim() || '[Registered address], Bhubaneswar, Odisha, India',
};

export function grievanceContact(): string {
  const officer = process.env.NEXT_PUBLIC_GRIEVANCE_OFFICER?.trim();
  const contact = process.env.NEXT_PUBLIC_GRIEVANCE_CONTACT?.trim();
  if (!contact) return 'Grievance officer: [name], [email], [phone]';
  return officer ? `${officer}, ${contact}` : contact;
}

export { DPA_VERSION, VENDOR_TERMS_VERSION } from '@/lib/legal-versions';

export function LegalPage({ title, updated, children, draftNote }: { title: string; updated: string; children: ReactNode; draftNote?: string }) {
  return (
    <article className="mx-auto max-w-3xl text-ink-800">
      <div role="note" className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
        {draftNote ?? 'Draft — to be reviewed by a lawyer before launch.'}
      </div>
      <h1 className="text-2xl font-semibold text-ink-900">{title}</h1>
      <p className="mt-1 text-sm text-ink-500">Last updated {updated}</p>
      <div className="mt-6 space-y-8">{children}</div>
      <p className="mt-10 border-t border-ink-100 pt-4 text-sm text-ink-500">
        See also: <Link href="/privacy" className="text-brand-700 underline">Privacy policy</Link> ·{' '}
        <Link href="/terms" className="text-brand-700 underline">Terms of use</Link> ·{' '}
        <Link href="/legal/vendor-terms" className="text-brand-700 underline">Vendor terms</Link> ·{' '}
        <Link href="/legal/dpa" className="text-brand-700 underline">Data processing agreement</Link>
      </p>
    </article>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mb-2 text-lg font-semibold text-ink-900">{title}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">{children}</div>
    </section>
  );
}
