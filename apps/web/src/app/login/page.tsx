import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in · Tiffin OS' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-2xl text-white">🍱</div>
          <h1 className="text-xl font-semibold">Tiffin OS</h1>
          <p className="mt-1 text-sm text-ink-500">Log in with your mobile number</p>
        </div>
        <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-ink-100">
          <LoginForm showDevHint={process.env.NODE_ENV !== 'production'} />
        </div>
      </div>
    </main>
  );
}
