import Link from 'next/link';
import type { ReactNode } from 'react';

// Shared layout for the privacy policy and terms (public website). Plain language, short sections.
export const OPERATOR = {
  name: '[Platform operator legal name]',
  brand: 'Tiffin Bhubaneswar',
  address: '[Registered address], Bhubaneswar, Odisha, India',
};

export function grievanceContact(): string {
  return process.env.NEXT_PUBLIC_GRIEVANCE_CONTACT || 'Grievance officer: [name], [email], [phone]';
}

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl text-ink-800">
      <div role="note" className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
        Draft — to be reviewed by a lawyer before launch.
      </div>
      <h1 className="text-2xl font-semibold text-ink-900">{title}</h1>
      <p className="mt-1 text-sm text-ink-500">Last updated {updated}</p>
      <div className="mt-6 space-y-8">{children}</div>
      <p className="mt-10 border-t border-ink-100 pt-4 text-sm text-ink-500">
        See also: <Link href="/privacy" className="text-brand-700 underline">Privacy policy</Link> ·{' '}
        <Link href="/terms" className="text-brand-700 underline">Terms of use</Link>
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
