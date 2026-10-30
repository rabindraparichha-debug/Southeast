'use client';

import { useEffect, useRef, useState } from 'react';
import { friendlyError } from '@/lib/errors';
import { scanToken } from '@/lib/p5';
import { BigButton, FieldInput, Muted, Panel } from '@/components/field-ui';

// Minimal typing for the Shape Detection API (Chrome on Android; not in TypeScript's DOM lib yet).
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector) ?? null;
}

/**
 * Optional sticker check before handing over a tiffin (P5). Scans the QR with the camera where the
 * browser can (BarcodeDetector), else the rider types the code under the QR. Checked here against the
 * stop's code (works offline) and again by complete_stop (wrong_tiffin).
 */
export function ScanSticker({ expected, value, onChange }: { expected: string | null | undefined; value: string | null; onChange: (token: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [wrong, setWrong] = useState(false);
  const [camError, setCamError] = useState('');
  const [canScan, setCanScan] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => setCanScan(Boolean(detectorCtor()) && Boolean(navigator.mediaDevices?.getUserMedia)), []);

  function check(raw: string) {
    const token = scanToken(raw);
    if (!token) return;
    if (expected && token !== scanToken(expected)) {
      setWrong(true);
      onChange(null);
      return;
    }
    setWrong(false);
    onChange(token);
    setOpen(false);
  }

  // Camera loop while the scanner is open.
  useEffect(() => {
    if (!open || !canScan) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    const Ctor = detectorCtor()!;
    const detector = new Ctor({ formats: ['qr_code'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!alive || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
        timer = setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          try {
            const codes = await detector.detect(video.current);
            if (alive && codes[0]?.rawValue) check(codes[0].rawValue);
          } catch {
            // keep trying
          }
        }, 300);
      } catch {
        if (alive) setCamError('Camera not available. Type the code printed under the QR instead.');
      }
    })();
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when opened/closed
  }, [open, canScan]);

  if (value && !wrong) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl bg-green-50 px-3 py-2.5 text-sm font-medium text-green-800 ring-1 ring-green-200" data-testid="scan-ok">
        <span>✓ Sticker matches this stop</span>
        <button type="button" className="text-xs text-green-700 underline" onClick={() => onChange(null)}>Clear</button>
      </div>
    );
  }

  return (
    <Panel tone={wrong ? 'danger' : undefined}>
      {wrong && (
        <p role="alert" className="rounded-lg bg-red-600 px-3 py-3 text-base font-bold text-white" data-testid="wrong-tiffin">
          ✋ {friendlyError({ message: 'wrong_tiffin' })}
        </p>
      )}
      {!open ? (
        <BigButton variant="secondary" onClick={() => { setCamError(''); setWrong(false); setOpen(true); }} data-testid="scan-sticker">
          🏷️ Check sticker (optional)
        </BigButton>
      ) : (
        <div className="space-y-2">
          {canScan && !camError && (
            <video ref={video} playsInline muted className="aspect-square w-full rounded-xl bg-ink-900 object-cover" aria-label="Camera: point at the QR on the sticker" />
          )}
          {camError && <Muted>{camError}</Muted>}
          {!canScan && <Muted>Type the code printed under the QR on the sticker.</Muted>}
          <div className="flex gap-2">
            <FieldInput value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder="Sticker code" autoCapitalize="characters"
              autoComplete="off" className="font-mono tracking-wider" data-testid="scan-code" />
            <button type="button" onClick={() => check(typed)} disabled={!typed.trim()}
              className="shrink-0 rounded-xl bg-brand-600 px-4 text-base font-semibold text-white disabled:opacity-60" data-testid="scan-check">Check</button>
          </div>
          <BigButton variant="secondary" onClick={() => setOpen(false)}>Close</BigButton>
        </div>
      )}
    </Panel>
  );
}
