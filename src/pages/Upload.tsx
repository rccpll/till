// Desktop screen: drop voucher PDFs, everything parses in the browser, only
// parsed facts + the barcode crop are uploaded. Also home of the JSON backup.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, TriangleAlert } from 'lucide-react';
import { api, type AppState, type AddRow } from '../lib/api';
import { euros, ddmmyyyy, parseEuros } from '../lib/format';
import type { ParsedVoucher, ParseOutcome } from '../lib/parseVoucherPdf';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

const LAST_GROUP_KEY = 'till:last-group';

type AttentionRow =
  | { id: number; file: string; kind: 'need_amount'; parsed: ParsedVoucher; amountInput: string; submitting?: boolean; error?: string }
  | { id: number; file: string; kind: 'mismatch'; detail: string; textCode: string | null; barcodeCode: string | null }
  | { id: number; file: string; kind: 'unparseable'; detail: string };

interface Summary {
  addedCount: number;
  addedCents: number;
  duplicates: number;
}

let rowId = 0;

export default function Upload() {
  const [state, setState] = useState<AppState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [group, setGroup] = useState(() => localStorage.getItem(LAST_GROUP_KEY) ?? '');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [attention, setAttention] = useState<AttentionRow[]>([]);
  const [exporting, setExporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshState = useCallback(() => {
    api.state().then(s => { setState(s); setStateError(null); })
      .catch(e => setStateError(String(e)));
  }, []);
  useEffect(refreshState, [refreshState]);

  const knownGroups = useMemo(
    () => [...new Set(state?.vouchers.map(v => v.issuer) ?? [])].sort(),
    [state],
  );

  const groupTrimmed = group.trim();

  async function handleFiles(files: File[]) {
    const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
    if (!pdfs.length || !groupTrimmed || busy) return;
    setBusy(true);
    setSummary(null);
    try {
      // pdfjs/zxing live in a lazy chunk that only the desktop page pulls in
      const { parseVoucherPdf } = await import('../lib/parseVoucherPdf');
      const outcomes: { file: string; outcome: ParseOutcome }[] = [];
      for (const f of pdfs) {
        outcomes.push({ file: f.name, outcome: await parseVoucherPdf(f, state?.gtin_amounts ?? {}) });
      }

      const ready: ParsedVoucher[] = [];
      const newAttention: AttentionRow[] = [];
      for (const { file, outcome } of outcomes) {
        if (outcome.kind === 'ok') ready.push(outcome.parsed);
        else if (outcome.kind === 'need_amount') {
          newAttention.push({ id: ++rowId, file, kind: 'need_amount', parsed: outcome.parsed, amountInput: '' });
        } else if (outcome.kind === 'mismatch') {
          newAttention.push({ id: ++rowId, file, kind: 'mismatch', detail: outcome.detail, textCode: outcome.textCode, barcodeCode: outcome.barcodeCode });
        } else {
          newAttention.push({ id: ++rowId, file, kind: 'unparseable', detail: outcome.detail });
        }
      }

      let added = 0, addedCents = 0, duplicates = 0;
      if (ready.length) {
        const rows: AddRow[] = ready.map(p => ({
          code: p.code,
          gtin: p.gtin,
          gs1_serial: p.gs1_serial,
          printed_serial: p.printed_serial,
          face_value_cents: p.face_value_cents!,
          expires_at: p.expires_at,
          issuer: groupTrimmed,
          barcode_png_b64: p.barcode_png_b64,
        }));
        const res = await api.addVouchers(rows);
        added = res.added.length;
        addedCents = res.added.reduce((s, v) => s + v.face_value_cents, 0);
        duplicates = res.skipped_duplicates.length;
      }
      localStorage.setItem(LAST_GROUP_KEY, groupTrimmed);
      setSummary({ addedCount: added, addedCents, duplicates });
      setAttention(prev => [...prev, ...newAttention]);
      refreshState();
    } catch (e) {
      setAttention(prev => [...prev, { id: ++rowId, file: '(batch)', kind: 'unparseable', detail: String(e) }]);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function confirmAmount(row: Extract<AttentionRow, { kind: 'need_amount' }>) {
    const cents = parseEuros(row.amountInput);
    if (cents == null || cents <= 0) {
      setAttention(rows => rows.map(r => r.id === row.id ? { ...row, error: 'enter an amount like 20 or 12,50' } : r));
      return;
    }
    setAttention(rows => rows.map(r => r.id === row.id ? { ...row, submitting: true, error: undefined } : r));
    try {
      const res = await api.addVouchers([{
        code: row.parsed.code,
        gtin: row.parsed.gtin,
        gs1_serial: row.parsed.gs1_serial,
        printed_serial: row.parsed.printed_serial,
        face_value_cents: cents,
        expires_at: row.parsed.expires_at,
        issuer: groupTrimmed,
        barcode_png_b64: row.parsed.barcode_png_b64,
      }]);
      if (res.skipped_duplicates.length) {
        setSummary(s => ({ addedCount: s?.addedCount ?? 0, addedCents: s?.addedCents ?? 0, duplicates: (s?.duplicates ?? 0) + 1 }));
      } else {
        setSummary(s => ({
          addedCount: (s?.addedCount ?? 0) + 1,
          addedCents: (s?.addedCents ?? 0) + cents,
          duplicates: s?.duplicates ?? 0,
        }));
      }
      setAttention(rows => rows.filter(r => r.id !== row.id));
      refreshState(); // gtin_amounts now knows this GTIN — future uploads are automatic
    } catch (e) {
      setAttention(rows => rows.map(r => r.id === row.id ? { ...row, submitting: false, error: String(e) } : r));
    }
  }

  async function exportBackup() {
    setExporting(true);
    try {
      const res = await fetch('/api/export');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `till-${new Date().toISOString().slice(0, 10)}.export.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      refreshState();
    } catch (e) {
      setStateError(`export failed: ${String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  function openPicker() {
    if (groupTrimmed && !busy) fileInput.current?.click();
  }

  const exportAgeDays = state?.last_export_at
    ? Math.floor((Date.now() - new Date(state.last_export_at).getTime()) / 86_400_000)
    : null;
  const exportNag = state != null && (exportAgeDays == null || exportAgeDays > 30);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Till — add vouchers</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            PDFs are parsed entirely in your browser and never leave this machine.
            Only the voucher facts and a small barcode image are stored.
          </p>
        </header>

        <section className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="group">Gift card group</Label>
            <Input
              id="group"
              className="w-64"
              placeholder="e.g. coop"
              list="known-groups"
              value={group}
              onChange={e => setGroup(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <datalist id="known-groups">
              {knownGroups.map(g => <option key={g} value={g} />)}
            </datalist>
            {!groupTrimmed && (
              <p className="text-xs text-muted-foreground">
                Name the group these vouchers belong to before dropping files.
              </p>
            )}
          </div>

          <div
            className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              !groupTrimmed || busy
                ? 'border-border/60 text-muted-foreground/50'
                : dragOver
                  ? 'border-foreground text-foreground bg-muted'
                  : 'border-border text-muted-foreground cursor-pointer hover:border-muted-foreground'
            }`}
            role="button"
            tabIndex={0}
            aria-disabled={!groupTrimmed || busy}
            aria-label="Drop voucher PDFs here, or activate to browse"
            onClick={openPicker}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault(); setDragOver(false);
              void handleFiles([...e.dataTransfer.files]);
            }}
          >
            {busy ? 'Parsing…' : 'Drop voucher PDFs here, or click to browse'}
            <input
              ref={fileInput} type="file" hidden multiple accept="application/pdf"
              onChange={e => void handleFiles([...(e.target.files ?? [])])}
            />
          </div>
        </section>

        {summary && (summary.addedCount > 0 || summary.duplicates > 0) && (
          <section className="space-y-1 text-sm" aria-live="polite">
            {summary.addedCount > 0 && (
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                {summary.addedCount} voucher{summary.addedCount === 1 ? '' : 's'} added automatically · {euros(summary.addedCents)}
              </p>
            )}
            {summary.duplicates > 0 && (
              <p className="text-muted-foreground">
                {summary.duplicates} duplicate{summary.duplicates === 1 ? '' : 's'} ignored · not stored
              </p>
            )}
          </section>
        )}

        {attention.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Needs attention</h2>
            <div className="rounded-xl border">
              <Table>
                <TableBody>
                  {attention.map(row => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs max-w-48 truncate">{row.file}</TableCell>
                      {row.kind === 'need_amount' && (
                        <>
                          <TableCell className="text-muted-foreground">
                            unknown amount · expires {ddmmyyyy(row.parsed.expires_at)}
                          </TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-2">
                              <Input
                                className="w-24 h-8 text-right tabular-nums"
                                placeholder="20,00"
                                inputMode="decimal"
                                autoComplete="off"
                                aria-label={`Amount for ${row.file}`}
                                value={row.amountInput}
                                onChange={e => setAttention(rows => rows.map(r => r.id === row.id ? { ...row, amountInput: e.target.value, error: undefined } : r))}
                                onKeyDown={e => e.key === 'Enter' && void confirmAmount(row)}
                              />
                              <span className="text-muted-foreground">€</span>
                              <Button
                                size="sm"
                                disabled={row.submitting}
                                onClick={() => void confirmAmount(row)}
                              >
                                {row.submitting ? 'Adding…' : 'Add'}
                              </Button>
                            </span>
                            {row.error && (
                              <span className="flex items-center gap-1 text-xs font-medium mt-1">
                                <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" /> {row.error}
                              </span>
                            )}
                          </TableCell>
                        </>
                      )}
                      {row.kind === 'mismatch' && (
                        <TableCell colSpan={2}>
                          <span className="flex items-center gap-1.5 font-medium">
                            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                            not added — {row.detail}
                          </span>
                          <span className="block text-xs text-muted-foreground font-mono mt-0.5">
                            text: {row.textCode ?? '—'} · barcode: {row.barcodeCode ?? '—'}
                          </span>
                        </TableCell>
                      )}
                      {row.kind === 'unparseable' && (
                        <TableCell colSpan={2}>
                          <span className="flex items-center gap-1.5 font-medium">
                            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                            not added — {row.detail}
                          </span>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}

        <Separator />

        <section className="space-y-3">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              onClick={() => void exportBackup()}
              disabled={exporting || !state}
            >
              {exporting ? 'Exporting…' : 'Export backup (JSON)'}
            </Button>
            {state?.last_export_at && (
              <span className="text-xs text-muted-foreground">
                last export {exportAgeDays === 0 ? 'today' : `${exportAgeDays} day${exportAgeDays === 1 ? '' : 's'} ago`}
              </span>
            )}
          </div>
          {exportNag && (
            <Alert>
              <TriangleAlert aria-hidden="true" className="size-4" />
              <AlertDescription>
                {state?.last_export_at
                  ? `The last backup is ${exportAgeDays} days old.`
                  : 'No backup has ever been taken.'}{' '}
                D1's free tier only keeps 7 days of point-in-time recovery — the export file is the real safety net.
              </AlertDescription>
            </Alert>
          )}
        </section>

        {stateError && (
          <p className="flex items-center gap-1.5 text-sm font-medium" role="alert">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" /> {stateError} — reload to retry.
          </p>
        )}
      </div>
    </main>
  );
}
