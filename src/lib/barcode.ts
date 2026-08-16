import { gs1_128, drawingSVG } from 'bwip-js/browser';
import { aiText } from './parse';

/**
 * Render the voucher's GS1-128 as an SVG string.
 * White background and a generous quiet zone are load-bearing: without them
 * scanners (and zxing) fail to lock on. Verified at a real Coop till.
 */
export function gs1Svg(code: string): string {
  const text = aiText(code);
  if (!text) throw new Error('voucher code is not (01)(21) GS1');
  return gs1_128({
    bcid: 'gs1-128',
    text,
    scale: 3,
    height: 15,
    includetext: false,
    backgroundcolor: 'FFFFFF',
    paddingwidth: 10,
    paddingheight: 4,
  }, drawingSVG());
}
