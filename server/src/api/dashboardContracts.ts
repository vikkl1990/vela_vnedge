/** Compile-time wire compatibility checks. Type-only imports never enter the runtime or dashboard bundle. */
import type { PaperConfig } from '../config.ts';
import type { positionView } from '../paper/engine.ts';
import type { DeltaCandle } from '../delta/rest.ts';
import type { PaperConfig as UiPaper } from '../../../dashboard/src/api/types/config.ts';
import type { Position as UiPosition } from '../../../dashboard/src/api/types/trading.ts';
import type { Candle as UiCandle } from '../../../dashboard/src/api/types/market.ts';
type Assert<T extends true> = T;
export type PaperContract = Assert<Pick<PaperConfig, keyof UiPaper> extends UiPaper ? true : false>;
export type PositionContract = Assert<ReturnType<typeof positionView> extends UiPosition ? true : false>;
export type CandleContract = Assert<DeltaCandle extends UiCandle ? true : false>;
