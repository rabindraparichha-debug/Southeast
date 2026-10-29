'use client';

import { Button } from './ui';

export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <Button variant="secondary" onClick={() => window.print()} className="print:hidden">
      🖨️ {label}
    </Button>
  );
}
