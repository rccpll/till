// The wallet: Available / History tabs, deliberately sparse cards, and the
// blocking sync-rejection banner. Tapping a card goes straight to the barcode.
import { useState } from 'react';
import { TriangleAlert, WifiOff } from 'lucide-react';
import type { Voucher } from '../../lib/api';
import {
  availableList, expiresSoon, headerCount, headerTotalCents, historyMonths, isSpentOpen,
} from '../../lib/derive';
import { euros, ddmmyyyy } from '../../lib/format';
import { shownLabel } from '../../lib/shown';
import { dismissRejection, useWallet } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status-badge';

export default function Wallet() {
  const wallet = useWallet();
  const [tab, setTab] = useState<'available' | 'history'>('available');

  const available = availableList(wallet.vouchers);
  const totalCents = headerTotalCents(wallet.vouchers);
  const count = headerCount(wallet.vouchers);
  const multiGroup = new Set(wallet.vouchers.map(v => v.issuer)).size > 1;
  const months = historyMonths(wallet.vouchers);

  return (
    <main className="min-h-screen bg-background text-foreground pb-16">
      <header className="border-b px-6 pt-[max(env(safe-area-inset-top),20px)] pb-5">
        <div className="max-w-md mx-auto">
          <h1 className="text-4xl font-semibold tracking-tight tabular-nums">{euros(totalCents)}</h1>
          <div className="mt-1 text-sm text-muted-foreground">
            {count} voucher{count === 1 ? '' : 's'} available
            {!wallet.online && (
              <span className="ml-2 inline-flex items-center gap-1">
                <WifiOff aria-hidden="true" className="size-3.5" /> offline
              </span>
            )}
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={v => setTab(v as 'available' | 'history')} className="max-w-md mx-auto px-6 mt-4">
        <TabsList className="w-full">
          <TabsTrigger value="available">Available</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="available" className="mt-2 space-y-2">
          {available.length === 0 ? (
            <div className="text-center py-16 space-y-2">
              <p className="text-muted-foreground">No vouchers available</p>
              <p className="text-xs text-muted-foreground">
                Add vouchers from a desktop at{' '}
                <span className="font-mono">{window.location.origin}/upload</span>
              </p>
            </div>
          ) : (
            available.map(v => (
              <VoucherCard
                key={v.id}
                voucher={v}
                pending={wallet.pendingIds.has(v.id)}
                showGroup={multiGroup}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-2 space-y-2">
          {months.length === 0 ? (
            <p className="text-center py-16 text-muted-foreground">Nothing here yet</p>
          ) : (
            months.map(m => (
              <section key={m.key} className="pt-2">
                <div className="flex items-baseline justify-between pb-1">
                  <h2 className="text-sm font-semibold">{m.label}</h2>
                  {m.spentCents > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">{euros(m.spentCents)} spent</span>
                  )}
                </div>
                <div className="space-y-2">
                  {m.entries.map(e => (
                    <button
                      key={e.voucher.id}
                      className="w-full rounded-xl border bg-card px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => navigate(`/v/${e.voucher.id}/details`)}
                    >
                      <div className="min-w-0">
                        <div className={`font-semibold tabular-nums ${e.kind === 'voided' ? 'text-muted-foreground line-through' : 'text-muted-foreground'}`}>
                          {euros(e.voucher.face_value_cents)}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {e.kind === 'used' && `used by ${e.voucher.used_by ?? '?'} · ${ddmmyyyy(e.when.slice(0, 10))}`}
                          {e.kind === 'voided' && `voided · ${ddmmyyyy(e.when.slice(0, 10))}`}
                          {e.kind === 'expired' && `expired ${ddmmyyyy(e.when)}`}
                        </div>
                      </div>
                      <StatusBadge kind={e.kind} />
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </TabsContent>
      </Tabs>

      {wallet.rejections.length > 0 && <RejectionBanner />}
    </main>
  );
}

function VoucherCard({ voucher: v, pending, showGroup }: { voucher: Voucher; pending: boolean; showGroup: boolean }) {
  const spent = isSpentOpen(v);
  const partial = v.remaining_cents > 0 && v.remaining_cents < v.face_value_cents;
  const shown = shownLabel(v.id);

  return (
    <button
      className={`w-full rounded-xl border bg-card px-5 py-4 text-left shadow-xs transition-[transform,background-color] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.99] ${spent ? 'opacity-55' : ''}`}
      onClick={() => navigate(`/v/${v.id}`)}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {euros(v.remaining_cents)}
          {partial && <span className="text-sm font-normal text-muted-foreground"> of {euros(v.face_value_cents)}</span>}
        </div>
        {showGroup && <span className="text-xs text-muted-foreground min-w-0 truncate">{v.issuer}</span>}
      </div>
      {(spent || pending || shown || expiresSoon(v)) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {spent && <StatusBadge kind="spent">spent</StatusBadge>}
          {pending && <StatusBadge kind="pending" />}
          {shown && <StatusBadge kind="shown">shown {shown}</StatusBadge>}
          {expiresSoon(v) && (
            <StatusBadge kind="expiring">expires {ddmmyyyy(v.expires_at)}</StatusBadge>
          )}
        </div>
      )}
    </button>
  );
}

function RejectionBanner() {
  const { rejections } = useWallet();
  const [open, setOpen] = useState(false);
  const r = rejections[0];
  if (!r) return null;

  const body = r.body as { reason?: string; used_by?: string | null; used_at?: string | null } | null;
  const detail =
    body?.reason === 'already_used'
      ? `already marked used by ${body.used_by ?? 'the other user'}${body.used_at ? ` at ${new Date(body.used_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : ''}`
      : body?.reason === 'voided'
        ? 'that voucher was voided'
        : `the server refused it (HTTP ${r.status})`;

  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-foreground text-background shadow-lg" role="alert">
      <div className="max-w-md mx-auto px-5 pt-[max(env(safe-area-inset-top),10px)] pb-3">
        <button
          className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/50 rounded"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          <span className="inline-flex items-center gap-1.5 font-semibold text-sm">
            <TriangleAlert aria-hidden="true" className="size-4" />
            {rejections.length} action{rejections.length === 1 ? " couldn't" : "s couldn't"} sync
          </span>
          <span className="text-background/70 text-sm"> · tap for details</span>
        </button>
        {open && (
          <div className="mt-2 space-y-2 text-sm">
            <p>
              Your “{r.action.endpoint.replace('_', ' ')}” from{' '}
              {new Date(r.action.client_ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{' '}
              was refused: {detail}. The server's version stands.
            </p>
            <Button variant="secondary" onClick={() => void dismissRejection(r.seq!)}>
              Understood, discard it
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
