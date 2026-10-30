'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// Small touch-friendly controls for the phone screens (rider mode, stock entry).

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Chip({ label, selected, onClick, testId }: { label: ReactNode; selected: boolean; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testId}
      className={cx(
        'min-h-10 rounded-full px-3.5 py-2 text-sm font-medium ring-1 transition',
        selected ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-ink-700 ring-ink-200 hover:bg-ink-50',
      )}
    >
      {label}
    </button>
  );
}

export function Stepper({ label, value, onChange, max = 20, testId }: { label: string; value: number; onChange: (n: number) => void; max?: number; testId?: string }) {
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      <span className="flex-1 text-sm text-ink-700">{label}</span>
      <button type="button" aria-label={`${label}: less`} onClick={() => onChange(Math.max(0, value - 1))}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-xl text-ink-800 ring-1 ring-ink-200 active:bg-ink-100">−</button>
      <span className="min-w-6 text-center text-lg font-semibold text-ink-900" aria-live="polite">{value}</span>
      <button type="button" aria-label={`${label}: more`} onClick={() => onChange(Math.min(max, value + 1))}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-xl text-ink-800 ring-1 ring-ink-200 active:bg-ink-100">+</button>
    </div>
  );
}

export function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'warn' | 'brand' | 'danger' }) {
  return (
    <section
      className={cx(
        'space-y-3 rounded-xl p-4 shadow-sm ring-1',
        tone === 'warn' ? 'bg-amber-50 ring-amber-200' : tone === 'brand' ? 'bg-brand-50 ring-brand-100' : tone === 'danger' ? 'bg-white ring-red-300' : 'bg-white ring-ink-100',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function BigButton({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-brand-600 text-white active:bg-brand-700',
        variant === 'secondary' && 'bg-white text-ink-800 ring-1 ring-ink-200 active:bg-ink-100',
        variant === 'danger' && 'bg-white text-red-700 ring-1 ring-red-200 active:bg-red-50',
        className,
      )}
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="text-sm font-medium text-red-700">{children}</p>;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-sm text-ink-500', className)}>{children}</p>;
}

export function FieldInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'block w-full min-w-0 rounded-xl border-0 bg-white px-3 py-3 text-base text-ink-900 ring-1 ring-ink-200 placeholder:text-ink-400 focus:ring-2 focus:ring-brand-500',
        props.className,
      )}
    />
  );
}
