// Everything the card deliberately hides: status, expiry, serials, who added
// it, the full server event log, and the recovery actions.
import { useEffect, useState } from 'react';
import { Ban, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import { api, type VoucherEvent } from '../../lib/api';
import { euros, ddmmyyyy } from '../../lib/format';
import { actions, useWallet } from '../../lib/store';
import { back } from '../../lib/router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { StatusBadge } from '@/components/status-badge';

const EVENT_LABELS: Record<VoucherEvent['type'], string> = {
  added: 'added',
  spent: 'partly used',
  used: 'marked used',
  unmarked: 'marked not used',
  voided: 'voided',
  already_empty: 'till said empty',
  scan_failed: 'scanner could not read',
};

export default function DetailsScreen({ id }: { id: string }) {
  const { vouchers, pendingIds } = useWallet();
  const voucher = vouchers.find(v => v.id === id);
  const [events, setEvents] = useState<VoucherEvent[] | null>(null);
  const [eventsError, setEventsError] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidNote, setVoidNote] = useState('');

  useEffect(() => {
    api.events(id).then(r => setEvents(r.events)).catch(() => setEventsError(true));
  }, [id, vouchers]);

  if (!voucher) {
    return (
      <main className="fixed inset-0 bg-white flex items-center justify-center">
        <p className="text-neutral-500">Voucher not found. <button className="underline" onClick={back}>Back</button></p>
      </main>
    );
  }

  const canUnmark = voucher.status !== 'available' || voucher.remaining_cents < voucher.face_value_cents;

  function unmark() {
    void actions.unmark(id);
    back();
    toast('Restored to available');
  }

  function confirmVoid() {
    void actions.void(id, voidNote.trim() || 'voided from details');
    back();
    toast('Voucher voided', {
      action: { label: 'Undo', onClick: () => { void actions.unmark(id); } },
    });
  }

  function fmtTs(iso: string): string {
    const d = new Date(iso);
    return `${ddmmyyyy(iso.slice(0, 10))} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  return (
    <main className="min-h-screen bg-white text-neutral-900" style={{ colorScheme: 'light' }}>
      <header className="flex items-center gap-1 px-2 pt-[max(env(safe-area-inset-top),12px)] pb-2">
        <Button variant="ghost" size="icon" className="size-11" onClick={back} aria-label="Back">
          <ChevronLeft aria-hidden="true" className="size-5" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Voucher details</h1>
      </header>

      <div className="px-6 pb-24 space-y-6 max-w-md mx-auto">
        <section className="space-y-1.5">
          <div className="text-3xl font-semibold tracking-tight tabular-nums">
            {euros(voucher.remaining_cents)}
            {voucher.remaining_cents < voucher.face_value_cents && (
              <span className="text-lg font-normal text-muted-foreground"> of {euros(voucher.face_value_cents)}</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="capitalize">{voucher.status}</span>
            {pendingIds.has(id) && <StatusBadge kind="pending" />}
          </div>
        </section>

        <section className="text-sm space-y-1.5">
          <Row label="Group" value={voucher.issuer} />
          <Row label="Expires" value={ddmmyyyy(voucher.expires_at)} />
          {voucher.printed_serial && <Row label="Printed serial" value={voucher.printed_serial} mono />}
          <Row label="Code" value={`${voucher.code.slice(0, 8)}…${voucher.code.slice(-6)}`} mono />
          <Row label="Added by" value={`${voucher.created_by} · ${ddmmyyyy(voucher.created_at.slice(0, 10))}`} />
          {voucher.used_by && voucher.used_at && (
            <Row
              label={voucher.status === 'voided' ? 'Voided by' : 'Used by'}
              value={`${voucher.used_by} · ${fmtTs(voucher.used_at)}`}
            />
          )}
        </section>

        <Separator />

        <section className="space-y-2">
          <Button
            variant="outline"
            className="w-full h-auto rounded-xl py-3"
            onClick={() => setShowOriginal(s => !s)}
          >
            {showOriginal ? 'Hide original barcode image' : 'Show original barcode image'}
          </Button>
          {showOriginal && (
            <img
              src={`/api/vouchers/${id}/original.png`}
              alt="original barcode"
              className="w-full [image-rendering:pixelated] border rounded bg-white"
            />
          )}
          {canUnmark && (
            <Button variant="outline" className="w-full h-auto rounded-xl py-3" onClick={unmark}>
              Mark as not used
            </Button>
          )}
          {voucher.status === 'available' && !voiding && (
            <Button
              variant="outline"
              className="w-full h-auto rounded-xl py-3"
              onClick={() => setVoiding(true)}
            >
              <Ban aria-hidden="true" /> Void this voucher…
            </Button>
          )}
          {voiding && (
            <div className="rounded-xl border p-3 space-y-2">
              <Input
                placeholder="Why? (e.g. refunded, damaged)"
                value={voidNote}
                onChange={e => setVoidNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmVoid(); }}
                autoComplete="off"
                enterKeyHint="done"
                autoFocus
              />
              <div className="flex gap-2">
                <Button variant="destructive" className="flex-1" onClick={confirmVoid}>
                  <Ban aria-hidden="true" /> Void it
                </Button>
                <Button variant="ghost" onClick={() => setVoiding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">History</h2>
          {events === null && !eventsError && <p className="text-sm text-muted-foreground">Loading…</p>}
          {eventsError && <p className="text-sm text-muted-foreground">Event log unavailable offline.</p>}
          {events && (
            <ol className="space-y-2">
              {[...events].reverse().map(e => (
                <li key={e.id} className="text-sm border-l-2 pl-3">
                  <div className="font-medium">
                    {EVENT_LABELS[e.type]}
                    {e.amount_cents != null && e.type !== 'added' && ` · ${euros(e.amount_cents)}`}
                    {e.type === 'added' && e.amount_cents != null && ` · ${euros(e.amount_cents)}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {e.actor} · {fmtTs(e.created_at)}
                    {e.note && <span className="block italic">{e.note}</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs pt-0.5' : ''}>{value}</span>
    </div>
  );
}
