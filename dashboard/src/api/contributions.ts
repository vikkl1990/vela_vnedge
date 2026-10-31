export interface ContributionSummary { total:number;matching:number;specified:number;paper:number;shadow:number;aliases:number;held:number;unverified:number }
export interface ContributionActivity { signals:number;opened:number;pending:number;blocked:number;reasons:Record<string,number> }
export interface ContributionRow {
 id:string;name:string;author:string;status:string;reason:string|null;aliasOf:string|null;
 readingSpecified:boolean;entryDisabled:boolean;channels:string[];cautions:number;role:string;
 profiles:{total:number;matching:number;changed:number;legacy:number;lastAt:number|null;tfs:string[]};
 cells:{paper:number;shadow:number;candidate:number;tracked:number};paper:ContributionActivity;shadow:ContributionActivity;closes:{paper:number;shadow:number};next:string;
}
export interface Contributions {at:number;from:number;to:number;summary:ContributionSummary;authors:Array<ContributionSummary&{author:string;major:boolean}>;rows:ContributionRow[];notes:string[];lastScreen:{runs?:number;finishedAt?:number;silentSkipped?:number}|null}
export interface ContributionDetail {
 id:string;name:string;url:string;hash:string;
 facts:{lines:number;inputs:number;channels:string[];totalCalls:number;calls:Array<{name:string;line:number;condition:string;title:string;code:string}>;cautions:string[];dependencies:string[]};
 reading:{sources:string[]|null;labels:string[]|null;rule:string|null;inputs:Record<string,unknown>;edge:boolean|null;invert:boolean;sides:string[]|null;timezone:string};
 profiles:Array<{market:string;tf:string;at:number;kind:string;entries:number;exits:number;bars:number|null;windowStart:number|null;windowEnd:number|null;evidence:string;error:string|null}>;
}
