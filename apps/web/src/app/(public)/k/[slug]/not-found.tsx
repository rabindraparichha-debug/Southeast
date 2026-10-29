import Link from 'next/link';

export default function KitchenNotFound() {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <div className="text-4xl" aria-hidden>🍱</div>
      <h1 className="mt-2 text-lg font-semibold">This kitchen isn’t listed</h1>
      <p className="mt-1 text-sm text-ink-500">It may have moved or is not taking customers through us right now.</p>
      <div className="mt-4 flex justify-center gap-4 text-sm">
        <Link href="/find" className="text-brand-700 underline">Find a tiffin near you</Link>
        <Link href="/kitchens" className="text-brand-700 underline">All kitchens</Link>
      </div>
    </div>
  );
}
