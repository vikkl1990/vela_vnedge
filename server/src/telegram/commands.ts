import type {App} from '../app.ts';

export type TelegramActions={
  mode:()=>string;
  read:(command:'status'|'positions'|'pnl'|'alerts')=>string;
  pause:()=>string;
  resumeKey:()=>string;
  resume:()=>string;
  closePreview:(id:number)=>{key:string;text:string}|null;
  close:(id:number,key:string)=>string;
};
const money=(n:number)=>`$${n.toFixed(2)}`;
export function stopDescription(p:{side:'long'|'short';entryPrice:number;sl:number|null;slOriginal:number|null;protection:{trailAfterR:number;peakR:number}|null}):string {
  if(p.sl===null)return 'No price stop recorded; inspect the dashboard.';
  const direction=p.side==='long'?1:-1,gain=(p.sl-p.entryPrice)*direction;
  let text=`SL ${p.sl} · ${gain>0?'beyond entry, before exit costs':gain===0?'at entry, before costs':'profit not locked'}`;
  const distance=p.slOriginal===null?0:Math.abs(p.entryPrice-p.slOriginal),trail=p.protection;
  if(trail&&trail.trailAfterR>0&&distance>0&&trail.peakR<trail.trailAfterR){
    const trigger=p.entryPrice+direction*distance*trail.trailAfterR;
    text+=` · trail arms at ${Number(trigger.toPrecision(8))} (+${trail.trailAfterR}R); peak +${trail.peakR.toFixed(2)}R`;
  }
  return text;
}

export function telegramActions(app:App):TelegramActions {
  const paperOnly=()=>{if(app.config.get().execution.mode!=='paper'||app.executor)throw Error('Telegram trade controls are available only in the paper account.');};
  const preview=(id:number)=>{
    const p=app.paper.openPositions().find(p=>p.id===id);
    return p?{key:JSON.stringify([p.id,p.entryAt,p.symbol,p.side,p.qtyOpen,p.policy?.id??null]),text:`Paper #${p.id}: ${p.side.toUpperCase()} ${p.symbol} ${p.tf}, ${p.qtyOpen} contracts. Close the remaining position using current execution rules.`}:null;
  };
  return {
    mode:()=>app.executor?'exchange':app.config.get().execution.mode,
    read(command){
      const stats=app.paper.stats(),risk=app.risk.state();
      if(command==='status')return `VN EDGE · ${app.config.get().execution.mode.toUpperCase()}\nEquity ${money(stats.equity)}\nOpen ${app.paper.openPositions().length} · pending entries ${app.paper.pendingEntries().length}\nEntries: ${risk.halted?'PAUSED · '+risk.haltReason:'running'}\nDelta feed: ${app.feed.connected?'connected':'disconnected'}`;
      if(command==='positions'){
        const positions=app.paper.openPositions();
        return `Paper positions · ${positions.length}\n`+(positions.length?positions.slice(0,10).map(p=>`#${p.id} ${p.side.toUpperCase()} ${p.symbol} ${p.tf} · ${p.qtyOpen} contracts · entry ${p.entryPrice}\n${stopDescription(app.paper.view(p))}`).join('\n'):'No open positions.')+(positions.length>10?'\nFirst 10 shown; see dashboard for the rest.':'');
      }
      if(command==='pnl'){
        const day=Math.floor(Date.now()/86400000)*86400000;
        const closed=app.db.get<{n:number;net:number;fees:number}>("SELECT COUNT(*) n,COALESCE(SUM(realized_pnl-fees),0) net,COALESCE(SUM(fees),0) fees FROM positions WHERE bt=0 AND status='closed' AND exit_at>=?",day)!;
        return `Paper P&L · today UTC\n${closed.n} closed trades\nNet after fees: ${money(closed.net)}\nFees: ${money(closed.fees)}\nEquity: ${money(stats.equity)}`;
      }
      const a=app.ops.alerts.status();
      return `Alerts: ${a.configured?'configured':'not configured'}\nActive: ${a.active.length?a.active.join(', '):'none'}\nSent: ${a.sent} · failed: ${a.failed} · suppressed: ${a.suppressed}`;
    },
    pause(){paperOnly();app.risk.kill('Telegram operator pause',false);return 'Paper entries paused. Existing positions keep their exit rules.';},
    resumeKey(){paperOnly();return JSON.stringify(app.risk.state().manualHalt);},
    resume(){paperOnly();const result=app.risk.resumeManual();return result.ok?'Manual paper pause cleared. Loss limits, cooldowns, margin and all entry gates still apply.':result.reason;},
    closePreview(id){paperOnly();return preview(id);},
    close(id,key){
      paperOnly();if(preview(id)?.key!==key)return 'Position changed or closed. Request a fresh /close confirmation.';
      const p=app.paper.closeManual(id);
      if(!p)return 'No open paper position with that ID.';
      return p.status==='closed'?`Paper #${id} closed. See /pnl for results.`:`Closure requested for paper #${id}. Execution is pending; use /positions to check.`;
    },
  };
}
