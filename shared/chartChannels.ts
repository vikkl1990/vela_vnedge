/** Comparable closed-run outputs, not a second trading reader or a promotion sample. */
export interface ChartChannels { alerts:string[];labels:string[];labelsVerified:boolean;truncated:boolean;unavailable?:string }
export function alertKey(a:{title?:unknown;message?:unknown;time?:number;barIndex?:number},bars:readonly {time:number}[]){
 const named=a.title&&typeof a.title==='object'?a.title as {title?:unknown;message?:unknown}:null;
 return JSON.stringify([a.time||bars[a.barIndex??-1]?.time||0,String(named?.title??a.title??''),String(a.message||(named?.message??''))]);
}
export function labelKey(l:{time?:number;y?:number;text?:string;style?:string;createdAt?:number;x?:number;xloc?:string;tooltip?:string},bars:readonly {time:number}[]){
 const x=l.x??0,time=l.time??((l.xloc==='bar_index'||(x>0&&x<1e9))?bars[Math.round(x)]?.time:x);
 const stamp=/^vn:(\d+)$/.exec(l.tooltip??'');
 return JSON.stringify([time??null,l.y??null,String(l.text??'').slice(0,80),String(l.style??'').replace(/^style_/,''),l.createdAt??(stamp?bars[Number(stamp[1])]?.time:null)??null]);
}
