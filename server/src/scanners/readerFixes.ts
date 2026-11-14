/**
 * Decision 241: three faults in the alert reader, found by the line-by-line script study (docs/research/script-study-2026-11-12).
 *
 *  1. A reversal written "Long → Short" closes the long. The reader took the first side word and inverted it, so the
 *     close was filed for the short side and the long stayed open.
 *  2. A title that closes a position ("Cierre Long", "Salida Short", "Long Win", "Short Loss") or reports that a
 *     pattern failed ("Measured Move Invalidated", "Band Walk Ended", "Support lost", "Bull Brake") carries a
 *     direction word and was read as an entry. Closing a position is an exit; a failed pattern is information.
 *  3. "Dn" was not a direction, so "Break Dn" was never read while "Break Up" was.
 *
 * A fix changes what a scanner trades, and a scanner's record means "this reading of this source". So the fixes are
 * opt-in: a scanner gets them when its reading says `reader: 2`. The reading is part of the trade policy's identity,
 * so a scanner that opts in starts a new record and every other scanner keeps its own. Genuine SELL entries are
 * untouched, and a title the scanner's `sides` contract names is read as the contract says.
 */
import type { ExitType, Side } from './extractor.ts';

/** The reader revision a scanner's reading opts into; 1 (or unset) is the reader its record was earned under. */
export const READER_FIXES = 2;

/** Explicit source contract for scripts that reuse one label glyph on both sides. */
export type LabelStyleSides = Record<string, Record<string, Side | 'none'>>;
export function labelStyleContractError(reader: number | undefined, value: unknown): string | null {
  if(value==null)return null;
  if(reader!==2)return 'labelStyles requires reader 2';
  const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const keys=(x:Record<string,unknown>)=>Object.keys(x).every(k=>!!k.trim())&&new Set(Object.keys(x).map(k=>k.trim().toLowerCase())).size===Object.keys(x).length;
  if(!record(value)||!keys(value)||Object.values(value).some(v=>!record(v)||!keys(v)||Object.values(v).some(s=>typeof s!=='string'||!['long','short','none'].includes(s))))return 'labelStyles must map unique label texts and exact styles to long|short|none';
  return null;
}
export function labelStyleSide(contract: LabelStyleSides | undefined, text: string, style: string | undefined): Side | 'none' | undefined {
  const entry=Object.entries(contract??{}).find(([k])=>k.trim().toLowerCase()===text.trim().toLowerCase());
  // A known glyph with an absent/unrecognised style must never fall back to generic direction inference.
  return entry?Object.entries(entry[1]).find(([k])=>k.trim().toLowerCase()===String(style??'').trim().toLowerCase())?.[1]??'none':undefined;
}

/** "Long → Short": the side before the arrow is the trade being closed. */
export const REVERSAL_ARROW = /\b(LONG|SHORT)\b\s*(?:→|->|=>|⇒|➔|➜)\s*\b(LONG|SHORT)\b/i;

/** A position being closed, in the words scripts use for it. */
const CLOSES = /\b(?:cierre|cerrar|salida)\s+(?:de\s+)?(long|short|buy|sell|compra|venta)\b|\b(long|short)\s+(?:win|loss)\b/i;

/** A pattern or state that failed or ended, or a closing word: never an entry, whatever direction word it carries. */
export const NOT_AN_ENTRY = /\b(?:invalidat\w*|ended|lost|brake|cierre|cerrar|salida)\b|\b(?:long|short)\s+(?:win|loss)\b/i;

const sideOf = (w: string): Side => (/^(long|buy|compra)$/i.test(w) ? 'long' : 'short');

/** The side a title or alert text closes, when it says it closes one. */
export function closesSide(text: string): { side: Side; exitType: ExitType } | undefined {
  const m = CLOSES.exec(text);
  return m ? { side: sideOf(m[1] ?? m[2]), exitType: 'close' } : undefined;
}

/** The side a reversal alert closes: the one before the arrow, when the text names both. */
export function reversalClosed(text: string): Side | undefined {
  const m = REVERSAL_ARROW.exec(text);
  return m ? sideOf(m[1]) : undefined;
}

/** A direction vocabulary change must not activate the classifier's regime markers. */
export function readerContractError(scannerId:string,reader:number|undefined,sides:Record<string,string>|undefined):string|null {
  if(reader!==2||!scannerId.startsWith('machine-learning-rsi-ai-classification-ranking-zeiierman'))return null;
  const map=new Map(Object.entries(sides??{}).map(([k,v])=>[k.trim().toLowerCase(),v]));
  return ['st flip up','st flip dn','trend flip up','trend flip down'].every(k=>map.get(k)==='none')?null:'reader 2 requires all ML RSI flip markers mapped to none';
}
