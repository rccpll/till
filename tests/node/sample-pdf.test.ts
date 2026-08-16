// Acceptance criteria 1 and 2, run against a REAL voucher PDF.
//
// The PDF contains live money, so it is gitignored and these tests are skipped
// when it's absent (e.g. in CI). Locally, drop any real voucher PDF in the
// repo root (Voucher_<amount>_<code>.pdf) or point SAMPLE_PDF at one.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractFromText, gs1FromCode, parseFilenameAmount, aiText } from '../../src/lib/parse';

const ROOT = path.resolve(__dirname, '../..');

async function findSamplePdf(): Promise<string | null> {
  if (process.env.SAMPLE_PDF) return process.env.SAMPLE_PDF;
  const entries = await readdir(ROOT).catch(() => []);
  const pdf = entries.find(e => /^Voucher_.+\.pdf$/i.test(e));
  return pdf ? path.join(ROOT, pdf) : null;
}

const samplePath = await findSamplePdf();

describe.skipIf(!samplePath)('real voucher PDF (criteria 1, 2)', () => {
  let text = '';
  let filename = '';
  let barcodeDigits: string | null = null;
  let barcodeSymbology: string | null = null;

  beforeAll(async () => {
    filename = path.basename(samplePath!);
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { readBarcodes } = await import('zxing-wasm/reader');
    const { PNG } = await import('pngjs');

    const doc = await getDocument({ data: new Uint8Array(await readFile(samplePath!)) }).promise;
    const page = await doc.getPage(1);
    text = (await page.getTextContent()).items
      .map((i: { str?: string }) => i.str ?? '')
      .join(' ');

    const opList = await page.getOperatorList();
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (opList.fnArray[i] !== OPS.paintImageXObject) continue;
      const img = await new Promise<{ width: number; height: number; data?: Uint8Array } | null>(
        res => page.objs.get(opList.argsArray[i][0], res),
      );
      if (!img?.data) continue;
      const png = new PNG({ width: img.width, height: img.height });
      const ch = img.data.length / (img.width * img.height);
      for (let p = 0, q = 0; p < img.width * img.height; p++) {
        const [r, g, b, a] = ch === 4
          ? [img.data[q++], img.data[q++], img.data[q++], img.data[q++]]
          : ch === 3
            ? [img.data[q++], img.data[q++], img.data[q++], 255]
            : ((v: number) => [v, v, v, 255])(img.data[q++]);
        png.data[p * 4] = r; png.data[p * 4 + 1] = g; png.data[p * 4 + 2] = b; png.data[p * 4 + 3] = a;
      }
      const results = await readBarcodes(new Blob([PNG.sync.write(png)]), { formats: ['Code128'], tryHarder: true });
      if (results[0]?.symbologyIdentifier === ']C1') {
        barcodeDigits = results[0].text.replace(/\D/g, '');
        barcodeSymbology = results[0].symbologyIdentifier;
        break;
      }
    }
    await doc.destroy();
  });

  it('criterion 2: text layer yields code, printed serial, expiry, amount from filename', () => {
    const facts = extractFromText(text);
    expect(facts.code).toMatch(/^\d{34}$/);
    expect(facts.printedSerial).toMatch(/^\d+$/);
    expect(facts.printedSerial).not.toBe(facts.code);
    expect(facts.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const amount = parseFilenameAmount(filename);
    expect(amount).toBeGreaterThan(0);
    // the filename embeds the code too — they must agree
    expect(filename).toContain(facts.code!);
  });

  it('embedded barcode decodes as GS1 and matches the text layer', () => {
    expect(barcodeSymbology).toBe(']C1');
    expect(barcodeDigits).toBe(extractFromText(text).code);
    expect(gs1FromCode(barcodeDigits!)).not.toBeNull();
  });

  it('criterion 1: bwip-js regeneration round-trips as ]C1 + the exact 34 digits', async () => {
    const bwipjs = (await import('bwip-js/node')).default;
    const { readBarcodes } = await import('zxing-wasm/reader');
    const code = extractFromText(text).code!;
    const png = await bwipjs.toBuffer({
      bcid: 'gs1-128',
      text: aiText(code)!,
      scale: 3,
      height: 15,
      includetext: false,
      backgroundcolor: 'FFFFFF',
      paddingwidth: 10,
      paddingheight: 4,
    });
    const results = await readBarcodes(new Blob([new Uint8Array(png)]), { formats: ['Code128'], tryHarder: true });
    expect(results).toHaveLength(1);
    expect(results[0].symbologyIdentifier).toBe(']C1');
    expect(results[0].text.replace(/\D/g, '')).toBe(code);
  });
});

describe.skipIf(!!samplePath)('real voucher PDF', () => {
  it.skip('skipped: no Voucher_*.pdf in the repo root and SAMPLE_PDF not set', () => {});
});
