/** Source-pinned, observation-only lifecycle adapters. Never inferred from drawing positions. */
import type {RuleContext} from './rules.ts';
import type {ScanEvent, Side} from './extractor.ts';
export const BREAKOUT_NATIVE='smart-money-breakout-signals-author-native-v1';
export const ML_RSI_NATIVE='machine-learning-rsi-ai-classification-ranking-zeiierman-author-native-v1';
export const STEALTH_NATIVE='stealthtrail-supertrend-author-native-v1';
export const TREND_CONTINUATION='vnedge-trend-continuation-v1';
export const plotLifecycle=(id:string|undefined)=>id===BREAKOUT_NATIVE||id===ML_RSI_NATIVE||id===STEALTH_NATIVE||id===TREND_CONTINUATION;
export const plotPrefix='VNEDGE lifecycle v1 ';
/** A native setup cannot acquire a different stop or fewer milestones after price moves. */
export function nativeGeometryError(id:string|undefined,side:Side,price:number,sl:number|undefined,tp:number[]):string|null {
 if(!plotLifecycle(id))return null;
 const dir=side==='long'?1:-1;
 if(!(price>0&&Number.isFinite(price))||!(sl!==undefined&&sl>0&&Number.isFinite(sl)&&dir*(price-sl)>0))return 'native stop crossed or unavailable';
 if((id===BREAKOUT_NATIVE||id===STEALTH_NATIVE||id===TREND_CONTINUATION)&&(tp.length!==(id===TREND_CONTINUATION?1:3)||tp.some((v,i)=>!(Number.isFinite(v)&&v>0&&dir*(v-(i===0?price:tp[i-1]))>0))))return 'native target crossed or unavailable';
 if(id===ML_RSI_NATIVE&&tp.length)return 'native ML RSI has no fixed target';
 return null;
}
export const lifecycleSources:Record<string,{hash:string;exports:string[]}>={
 [TREND_CONTINUATION]:{hash:'25c75b0320b34efc287dd923d5ffa3edb4c3e1035d25614d657aa34d486aed65',exports:[]},
 [STEALTH_NATIVE]:{hash:'81fcc87d1c10ab60fd2049d679f8e7122f23c5675402fd04b5ae6a5d84aab6b6',exports:[
  'plot(openLong ? 1 : openShort ? -1 : 0, title="VNEDGE lifecycle v1 entry", display=display.none)',
  'plot(nz(activeSL, 0), title="VNEDGE lifecycle v1 stop", display=display.none)',
  'plot(nz(activeTP1, 0), title="VNEDGE lifecycle v1 tp1", display=display.none)',
  'plot(nz(activeTP2, 0), title="VNEDGE lifecycle v1 tp2", display=display.none)',
  'plot(nz(activeTP3, 0), title="VNEDGE lifecycle v1 tp3", display=display.none)',
  'plot(nz(activeDir[1], 0), title="VNEDGE lifecycle v1 exitSide", display=display.none)',
  'plot(slHit ? (exitBeActive ? 2 : 1) : tp3FirstTouch ? 3 : flipClose ? 4 : 0, title="VNEDGE lifecycle v1 close", display=display.none)',
  'plot(tp1FirstTouch ? 1 : 0, title="VNEDGE lifecycle v1 hit1", display=display.none)',
  'plot(tp2FirstTouch ? 1 : 0, title="VNEDGE lifecycle v1 hit2", display=display.none)',
  'plot(beJustActivated ? exitEntry : 0, title="VNEDGE lifecycle v1 amend", display=display.none)',
 ]},
 [BREAKOUT_NATIVE]:{hash:'89e7d2f427bafb8ed0addffe04797705cebaf52f4327823644f497b3a3f8291c',exports:[
  'plot(highBroken and not lowBroken ? 1 : lowBroken and not highBroken ? -1 : 0, title="VNEDGE lifecycle v1 entry", display=display.none)',
  'plot(SL, title="VNEDGE lifecycle v1 stop", display=display.none)',
  'plot(TP2, title="VNEDGE lifecycle v1 tp1", display=display.none)',
  'plot(TP1, title="VNEDGE lifecycle v1 tp2", display=display.none)',
  'plot(TP, title="VNEDGE lifecycle v1 tp3", display=display.none)',
 ]},
 [ML_RSI_NATIVE]:{hash:'d2d99ab55dc5429b7c77690d120f38aacc90a4eb158426f35396e02a11c70618',exports:[
  'plot(triggerLong and not triggerShort ? 1 : triggerShort and not triggerLong ? -1 : 0, title="VNEDGE lifecycle v1 entry", display=display.none)',
  'plot(stLine, title="VNEDGE lifecycle v1 stop", display=display.none)',
  'plot(stDir, title="VNEDGE lifecycle v1 direction", display=display.none)',
  'plot(stFlipUp ? 1 : stFlipDn ? -1 : 0, title="VNEDGE lifecycle v1 flip", display=display.none)',
 ]},
};

export function readPlotLifecycle(ctx:RuleContext):ScanEvent[]{
 const ml=ctx.scannerId===ML_RSI_NATIVE,stealth=ctx.scannerId===STEALTH_NATIVE,trend=ctx.scannerId===TREND_CONTINUATION,out:ScanEvent[]=[];
 const targetNames=trend?['tp1']:['tp1','tp2','tp3'];
 const names=ml?['entry','stop','direction','flip']:['entry','stop',...targetNames,...(stealth?['exitSide','close','hit1','hit2','amend']:[])];
 const maps=new Map(names.map(name=>{
  const found=(ctx.plots??[]).filter(p=>p.title===plotPrefix+name);
  if(found.length!==1)throw Error('Missing or duplicate lifecycle plot: '+name);
  return [name,new Map(found[0].data.map(d=>[d.time,d.value]))] as const;
 }));
 const value=(name:string,t:number)=>{const v=maps.get(name)?.get(t);return typeof v==='number'&&Number.isFinite(v)?v:undefined;};
 for(const [i,b] of ctx.bars.entries()){
  const t=b.time, signal=value('entry',t), stop=value('stop',t);
  const emit=(kind:ScanEvent['kind'],side:Side,label:string,extra:Partial<ScanEvent>={})=>out.push({kind,side,label,message:label,source:'derived',tp:[],barTime:t,barIndex:i,...extra});
  if(stealth){
   const old=value('exitSide',t),closed=value('close',t),amend=value('amend',t);
   if(old===1||old===-1){
    const side=old===1?'long':'short';
    // The old position closes before a same-bar reversal opens. Prices are observations,
    // never retrospective fills; the causal execution engine handles the instruction.
    const exitType=closed===1?'sl':closed===2?'be':closed===3?'tp3':closed===4?'flip':undefined;
    if(exitType)emit('exit',side,'Stealth native '+exitType,{exitType});
    else{
     if(value('hit1',t)===1)emit('exit',side,'Stealth TP1 milestone',{exitType:'tp1'});
     if(value('hit2',t)===1)emit('exit',side,'Stealth TP2 milestone',{exitType:'tp2'});
     if(amend!==undefined&&amend>0)emit('exit',side,'Stealth break-even amendment',{exitType:'stop_update',price:amend});
    }
   }
  }
  if(ml){
   const flip=value('flip',t),direction=value('direction',t);
   // A trend flip closes the OLD side. It never becomes a classifier entry.
   if(flip===1||flip===-1)emit('exit',flip===1?'short':'long','ML Supertrend reversal',{exitType:'flip'});
   if(stop!==undefined&&stop>0&&(direction===1||direction===-1))
    emit('exit',direction===1?'long':'short','ML Supertrend stop',{exitType:'stop_update',price:stop});
  }
  if(signal!==1&&signal!==-1)continue;
  const side=signal===1?'long':'short',tp=ml?[]:targetNames.map(n=>value(n,t));
  const valid=stop!==undefined&&stop>0&&signal*(b.close-stop)>0&&
   (ml?value('direction',t)===signal:tp.every((p,j)=>p!==undefined&&p>0&&signal*(p-(j===0?b.close:tp[j-1]!))>0));
  if(!valid){
   out.push({kind:'info',side,label:'Native geometry unavailable',message:'No entry: native stop/targets invalid at confirmed close',source:'derived',tp:[],barTime:t,barIndex:i});
   continue;
  }
  emit('entry',side,ml?'ML classifier confirmed':stealth?'Stealth confirmed':trend?'VNEDGE trend continuation confirmed':'Structure breakout confirmed',{price:b.close,sl:stop,tp:tp as number[]});
 }
 return out;
}
