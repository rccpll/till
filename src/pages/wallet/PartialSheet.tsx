// Bottom sheet for partial use. Two fields, each computing the other from the
// CURRENT remaining. Free numeric entry — receipts say things like 13,47 €.
import { useEffect, useId, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { euros, parseEuros } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function PartialSheet({ remainingCents, onConfirm, onClose }: {
  remainingCents: number;
  onConfirm: (usedCents: number) => void;
  onClose: () => void;
}) {
  const [used, setUsed] = useState('');
  const [left, setLeft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function syncFromUsed(value: string) {
    setUsed(value);
    setError(null);
    const cents = parseEuros(value);
    if (cents != null && cents >= 0 && cents <= remainingCents) {
      setLeft(((remainingCents - cents) / 100).toFixed(2).replace('.', ','));
    } else {
      setLeft('');
    }
  }

  function syncFromLeft(value: string) {
    setLeft(value);
    setError(null);
    const cents = parseEuros(value);
    if (cents != null && cents >= 0 && cents <= remainingCents) {
      setUsed(((remainingCents - cents) / 100).toFixed(2).replace('.', ','));
    } else {
      setUsed('');
    }
  }

  function confirm() {
    const usedCents = parseEuros(used);
    if (usedCents == null || usedCents <= 0) {
      setError('Enter how much was used, like 13,47');
      return;
    }
    if (usedCents > remainingCents) {
      setError(`Only ${euros(remainingCents)} is left on this voucher`);
      return;
    }
    onConfirm(usedCents);
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute bottom-0 inset-x-0 rounded-t-2xl border-t bg-background p-6 pb-[max(env(safe-area-inset-bottom),40px)] space-y-4 shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">Only partly used</h2>
        <p className="text-sm text-muted-foreground tabular-nums">{euros(remainingCents)} left before this purchase.</p>

        <div className="space-y-1.5">
          <Label htmlFor="partial-used">Amount used</Label>
          <div className="flex items-center gap-2">
            <Input
              id="partial-used"
              className="w-32 h-11 text-right !text-lg tabular-nums"
              inputMode="decimal" autoComplete="off" enterKeyHint="next"
              placeholder="0,00" value={used}
              onChange={e => syncFromUsed(e.target.value)} autoFocus
            />
            <span className="text-muted-foreground">€</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="partial-left">Amount left</Label>
          <div className="flex items-center gap-2">
            <Input
              id="partial-left"
              className="w-32 h-11 text-right !text-lg tabular-nums"
              inputMode="decimal" autoComplete="off" enterKeyHint="done"
              placeholder="0,00" value={left}
              onChange={e => syncFromLeft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirm(); }}
            />
            <span className="text-muted-foreground">€</span>
          </div>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-sm font-medium" role="alert">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" /> {error}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <Button className="flex-1 h-12 rounded-xl" onClick={confirm}>
            Save
          </Button>
          <Button variant="ghost" className="h-12 rounded-xl px-5" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
