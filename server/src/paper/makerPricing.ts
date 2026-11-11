import type {PaperConfig} from '../config.ts';
import type {Side} from '../scanners/extractor.ts';

/** Explicit cell opt-in: a quote-relative maker offset is a different evidence policy. */
export function quoteMakerCell(cfg:PaperConfig,cell:{scannerId:string;symbol:string;tf:string}):boolean {
  return cfg.makerQuoteCells?.some(r=>r.scannerId===cell.scannerId&&r.symbol===cell.symbol&&r.tf===cell.tf)??false;
}

/** Directional ticks and the executable opposite quote keep an order strictly passive. */
export function passiveMakerPrice(side:Side,reference:number,offset:number,atr:number,tick:number,executable?:number):number {
  const raw=side==='long'?reference-offset*atr:reference+offset*atr;
  const passive=executable===undefined?raw:side==='long'?Math.min(raw,executable-tick):Math.max(raw,executable+tick);
  return tick>0?Number(((side==='long'?Math.floor(passive/tick+1e-9):Math.ceil(passive/tick-1e-9))*tick).toPrecision(14)):passive;
}

/** Empty carried-forward OHLC bars are not evidence that an order could trade. */
export const tradedVolume=(volume:number|undefined):boolean=>Number.isFinite(volume)&&volume!>0;
