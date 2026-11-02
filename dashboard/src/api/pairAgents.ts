export interface PairAgentsView {
  enabled: boolean; at: number; lastAt: number; status: string; usedToday: number; nextAt: number;
  settings: {maxJobsPerDay:number;scannersPerJob:number;marketsPerJob:number;refreshDays:number;budgetMinutes:number};
  scannerCount:number;tfs:string[];eligible:number;dueCells:number;queueBusy:boolean;
  markets:Array<{symbol:string;turnover:number;eligible:boolean;reasons:string[];account:number;shadow:number;tracked:number;candidates:number;screened:number;passed:number;due:number;cells:number}>;
  running:{label:string;startedAt?:number;progress?:{done:number;scripts:number;runs:number;passed:number}}|null;
  history:Array<{id:string;label:string;status:string;finishedAt?:number;summary?:string;error?:string}>;
}
