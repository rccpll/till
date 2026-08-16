// Full-screen barcode. Always light — a dark barcode on a dark screen doesn't
// scan. Rendered as SVG from the stored code; the original PDF crop is one tap
// away as a fallback. In portrait the symbol is rotated 90° so the bars get
// the full screen height (a 34-digit GS1-128 is wide; width is everything).
// Colors on this screen are literal (bg-white, neutral text), never theme
// tokens: the symbol must stay pure black on pure white with its quiet zone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { euros } from '../../lib/format';
import { gs1Svg } from '../../lib/barcode';
import { markShown } from '../../lib/shown';
import { actions, useWallet } from '../../lib/store';
import { back, navigate } from '../../lib/router';
import { Button } from '@/components/ui/button';
import SwipeToUse from './SwipeToUse';
import PartialSheet from './PartialSheet';

export default function BarcodeScreen({ id }: { id: string }) {
  const { vouchers } = useWallet();
  const voucher = vouchers.find(v => v.id === id);
  const [showPartial, setShowPartial] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [originalError, setOriginalError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);

  const svg = useMemo(() => {
    if (!voucher) return null;
    try { return gs1Svg(voucher.code); } catch { return null; }
  }, [voucher]);

  // keep the screen awake while the cashier scans (silently unavailable on
  // installed iOS PWAs before 18.4)
  useEffect(() => {
    let cancelled = false;
    async function acquire() {
      try {
        const lock = await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } })
          .wakeLock?.request('screen');
        if (lock && !cancelled) wakeLock.current = lock;
        else void lock?.release();
      } catch { /* fails silently by design */ }
    }
    void acquire();
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void wakeLock.current?.release().catch(() => {});
      wakeLock.current = null;
    };
  }, [id]);

  // the device-local "shown" marker after 3 s on screen
  useEffect(() => {
    const t = setTimeout(() => markShown(id), 3000);
    return () => clearTimeout(t);
  }, [id]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  if (!voucher) {
    return (
      <main className="fixed inset-0 bg-white flex items-center justify-center">
        <p className="text-neutral-500">Voucher not found. <button className="underline" onClick={back}>Back</button></p>
      </main>
    );
  }

  function markUsed() {
    void actions.use(id);
    back();
    toast(`Marked as used · ${euros(voucher!.remaining_cents)}`, {
      action: { label: 'Undo', onClick: () => { void actions.unmark(id); } },
    });
  }

  function partialConfirm(usedCents: number) {
    void actions.spend(id, usedCents);
    setShowPartial(false);
    back();
    toast(`${euros(usedCents)} used · ${euros(voucher!.remaining_cents - usedCents)} left`, {
      action: { label: 'Undo', onClick: () => { void actions.unmark(id); } },
    });
  }

  const symbol = showOriginal ? (
    originalError ? (
      <p className="text-center text-sm text-neutral-500 py-4">
        Original image unavailable (offline?). The regenerated barcode encodes identically.
      </p>
    ) : (
      <img
        src={`/api/vouchers/${id}/original.png`}
        alt=""
        className="max-w-full max-h-full w-full h-full object-contain [image-rendering:pixelated] bg-white"
        onError={() => setOriginalError(true)}
      />
    )
  ) : svg ? (
    <div
      className="w-full h-full [&>svg]:block [&>svg]:w-full [&>svg]:h-full bg-white"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <p className="text-center text-sm font-medium text-neutral-900">
      Could not render barcode — try “Show original barcode” below.
    </p>
  );

  const graphic = (
    <div className="relative w-full h-full">
      <div className="absolute left-1/2 top-1/2 flex h-full w-full -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center portrait:h-[100cqi] portrait:w-[100cqh] portrait:rotate-90">
        <div className="flex min-h-0 min-w-0 w-full flex-1 items-center justify-center">
          {symbol}
        </div>
        <p className="mt-2 shrink-0 text-center font-mono text-[13px] tracking-[0.14em] text-neutral-700 select-all">
          {voucher.code}
        </p>
      </div>
    </div>
  );

  return (
    <main className="fixed inset-0 bg-white text-neutral-900 flex flex-col" style={{ colorScheme: 'light' }}>
      <header className="flex items-center justify-between px-2 pt-[max(env(safe-area-inset-top),12px)] pb-1 shrink-0">
        <Button variant="ghost" size="icon" className="size-11" onClick={back} aria-label="Back">
          <ChevronLeft aria-hidden="true" className="size-5" />
        </Button>
        <div className="text-sm font-medium tabular-nums">
          {euros(voucher.remaining_cents)}
          {voucher.remaining_cents < voucher.face_value_cents && (
            <span className="text-neutral-400"> of {euros(voucher.face_value_cents)}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          onClick={() => navigate(`/v/${id}/details`)}
          aria-label="Details"
        >
          <MoreHorizontal aria-hidden="true" className="size-5" />
        </Button>
      </header>

      <div className="@container-size flex-1 min-h-0 flex items-center justify-center py-1 px-12">
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          className="w-full h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 rounded"
          aria-label="Show barcode fullscreen"
        >
          {graphic}
        </button>
      </div>

      <footer className="px-4 pb-[max(env(safe-area-inset-bottom),16px)] space-y-3 shrink-0">
        <SwipeToUse label="Mark as used" onComplete={markUsed} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-auto py-2.5 px-1 whitespace-normal" onClick={() => setShowPartial(true)}>
            Only partly used…
          </Button>
          <Button
            variant="outline"
            className="h-auto py-2.5 px-1 whitespace-normal"
            onClick={() => { setOriginalError(false); setShowOriginal(s => !s); }}
          >
            {showOriginal ? 'Show regenerated barcode' : 'Show original barcode'}
          </Button>
        </div>
      </footer>

      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-white @container-size flex items-center justify-center pt-[max(44px,env(safe-area-inset-top))] pr-[max(44px,env(safe-area-inset-right))] pb-[max(44px,env(safe-area-inset-bottom))] pl-[max(44px,env(safe-area-inset-left))]"
          style={{ colorScheme: 'light' }}
          onClick={() => setFullscreen(false)}
          role="button"
          tabIndex={0}
          aria-label="Close fullscreen barcode"
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setFullscreen(false); }}
        >
          {graphic}
        </div>
      )}

      {showPartial && (
        <PartialSheet
          remainingCents={voucher.remaining_cents}
          onConfirm={partialConfirm}
          onClose={() => setShowPartial(false)}
        />
      )}
    </main>
  );
}
