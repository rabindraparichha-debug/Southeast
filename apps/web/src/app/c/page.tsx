// Customer magic-link pages (pay, pause, skip, menu, balance) arrive in M4 (package 2.3).
export default function CustomerHome() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 text-center">
      <div>
        <div className="text-4xl">🍱</div>
        <h1 className="mt-2 text-lg font-semibold">Your tiffin page</h1>
        <p className="mt-1 text-sm text-ink-500">Open the link your kitchen sent you on WhatsApp.</p>
      </div>
    </main>
  );
}
