// Client-side voucher PDF parsing. The PDF never leaves the machine: text and
// barcode are extracted in the browser, only ~4.5 KB of parsed facts +
// barcode crop are ever uploaded.
//
// This module (and its pdfjs/zxing imports) must ONLY be loaded from the
// desktop upload page — the mobile bundle must never include pdfjs-dist
// (acceptance criterion 12). Keep every import of it dynamic.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { prepareZXingModule, readBarcodes, type ReadResult } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { extractFromText, gs1FromCode, parseFilenameAmount } from './parse';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? wasmUrl : prefix + path,
  },
});

export type ParseOutcome =
  /** text + barcode agree, GS1 shape valid — safe to add */
  | { kind: 'ok'; parsed: ParsedVoucher }
  /** parsed, but no amount could be determined — ask the user */
  | { kind: 'need_amount'; parsed: ParsedVoucher }
  /** the text layer and the embedded barcode DISAGREE — never auto-accept */
  | { kind: 'mismatch'; textCode: string | null; barcodeCode: string | null; detail: string }
  | { kind: 'unparseable'; detail: string };

export interface ParsedVoucher {
  code: string;
  gtin: string;
  gs1_serial: string;
  printed_serial: string | null;
  expires_at: string;
  face_value_cents: number | null;
  amount_source: 'filename' | 'gtin' | null;
  barcode_png_b64: string;
}

async function decodeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ReadResult | null> {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const results = await readBarcodes(imageData, { formats: ['Code128'], tryHarder: true });
  return results[0] ?? null;
}

interface PdfImage {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8ClampedArray | Uint8Array;
}

function imageToCanvas(img: PdfImage): OffscreenCanvas {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvas;
  }
  const data = img.data!;
  const imageData = ctx.createImageData(img.width, img.height);
  const ch = data.length / (img.width * img.height);
  for (let p = 0, q = 0; p < img.width * img.height; p++) {
    if (ch === 4) {
      imageData.data[p * 4] = data[q++]; imageData.data[p * 4 + 1] = data[q++];
      imageData.data[p * 4 + 2] = data[q++]; imageData.data[p * 4 + 3] = data[q++];
    } else if (ch === 3) {
      imageData.data[p * 4] = data[q++]; imageData.data[p * 4 + 1] = data[q++];
      imageData.data[p * 4 + 2] = data[q++]; imageData.data[p * 4 + 3] = 255;
    } else {
      const v = data[q++];
      imageData.data[p * 4] = v; imageData.data[p * 4 + 1] = v;
      imageData.data[p * 4 + 2] = v; imageData.data[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function canvasToPngB64(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

export async function parseVoucherPdf(
  file: File,
  knownGtinAmounts: Record<string, number>,
): Promise<ParseOutcome> {
  let doc: pdfjs.PDFDocumentProxy;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({ data }).promise;
  } catch (e) {
    return { kind: 'unparseable', detail: `not a readable PDF (${(e as Error).message})` };
  }

  try {
    const page = await doc.getPage(1);

    // ---- text layer
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map(i => ('str' in i ? i.str : ''))
      .join(' ');
    const facts = extractFromText(text);

    // ---- embedded images -> the one that decodes as GS1 Code 128
    const opList = await page.getOperatorList();
    let barcode: { canvas: OffscreenCanvas; result: ReadResult } | null = null;
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (opList.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
      const objId = opList.argsArray[i][0] as string;
      const img = await new Promise<PdfImage | null>(res => {
        try { page.objs.get(objId, (v: PdfImage | null) => res(v)); } catch { res(null); }
      });
      if (!img || (!img.bitmap && !img.data)) continue;
      try {
        const canvas = imageToCanvas(img);
        const result = await decodeCanvas(canvas);
        if (result?.symbologyIdentifier === ']C1') {
          barcode = { canvas, result };
          break;
        }
      } catch { /* try the next image */ }
    }

    const barcodeCode = barcode ? barcode.result.text.replace(/\D/g, '') : null;
    const barcodeCanvas = barcode?.canvas ?? null;

    // ---- cross-check: the barcode is the money; text must agree
    if (!facts.code && !barcodeCode) {
      return { kind: 'unparseable', detail: 'no 34-digit code in the text layer and no GS1 barcode image found' };
    }
    if (!barcodeCode || !barcodeCanvas) {
      return {
        kind: 'mismatch', textCode: facts.code, barcodeCode: null,
        detail: 'text layer has a code but no embedded image decodes as GS1-128',
      };
    }
    if (!facts.code) {
      return {
        kind: 'mismatch', textCode: null, barcodeCode,
        detail: 'barcode decodes but the text layer has no 34-digit code',
      };
    }
    if (facts.code !== barcodeCode) {
      return {
        kind: 'mismatch', textCode: facts.code, barcodeCode,
        detail: 'text layer and barcode image disagree',
      };
    }

    const gs1 = gs1FromCode(barcodeCode);
    if (!gs1) {
      return { kind: 'mismatch', textCode: facts.code, barcodeCode, detail: 'code is not (01)(21) GS1' };
    }
    if (!facts.expiresAt) {
      return { kind: 'unparseable', detail: 'could not find "Valido fino al" expiry date' };
    }

    // ---- amount: filename first, then known GTIN amounts, else ask
    const fromFilename = parseFilenameAmount(file.name);
    const fromGtin = knownGtinAmounts[gs1.gtin];
    const face_value_cents = fromFilename ?? fromGtin ?? null;

    const parsed: ParsedVoucher = {
      code: barcodeCode,
      gtin: gs1.gtin,
      gs1_serial: gs1.serial,
      printed_serial: facts.printedSerial,
      expires_at: facts.expiresAt,
      face_value_cents,
      amount_source: fromFilename != null ? 'filename' : fromGtin != null ? 'gtin' : null,
      barcode_png_b64: await canvasToPngB64(barcodeCanvas),
    };
    return face_value_cents != null ? { kind: 'ok', parsed } : { kind: 'need_amount', parsed };
  } catch (e) {
    return { kind: 'unparseable', detail: (e as Error).message };
  } finally {
    await doc.destroy();
  }
}
