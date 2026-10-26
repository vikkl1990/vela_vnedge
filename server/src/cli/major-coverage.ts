/** Audit major-pair observation coverage; --apply adds watch-only cells, never account allocations. */
import {ConfigStore} from '../config.ts';
import {Db} from '../db.ts';
import {ScannerRegistry} from '../scanners/registry.ts';
import {ScriptHealth} from '../scanners/health.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {saveTracker} from '../incubator/tracker.ts';
const cfg=new ConfigStore().get(),db=new Db(),registry=new ScannerRegistry(),health=new ScriptHealth(db),store=new IncubatorStore(db);
const symbols=['BTCUSD','ETHUSD','SOLUSD','XRPUSD','BNBUSD','DOGEUSD','ADAUSD','AVAXUSD','LINKUSD','SUIUSD'];
const scanners=registry.all().filter(s=>s.status==='ok'&&cfg.scanners[s.id]?.enabled&&!cfg.scanners[s.id]?.hidden&&!health.isQuarantined(s.id)).map(s=>s.id).sort();
if(!cfg.incubator.enabled||!scanners.length)throw Error('enabled incubator and healthy enabled scanners required');
const def={id:'enabled-major-coverage',name:'Enabled scanners on major pairs',scanners,symbols,tfs:['15m','1h','4h']};
const preserved=new Set(['shadow','proposed','live','demote_proposed','tracked']);
const missing=scanners.flatMap(scannerId=>symbols.flatMap(symbol=>def.tfs.map(tf=>({scannerId,symbol,tf})))).filter(c=>!preserved.has(store.find(c.scannerId,c.symbol,c.tf)?.stage??''));
console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'dry-run',scannerCount:scanners.length,totalCells:scanners.length*symbols.length*def.tfs.length,missing:missing.length,definition:def,...(process.argv.includes('--apply')?{result:saveTracker(db,store,def)}:{})}));
db.db.close();
