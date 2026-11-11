/** Read-only export of checksum-verified, sealed replay segments. No engine/database writes.
 * node server/src/cli/replay-export.ts DATA/replay output.ndjson FROM_ISO TO_ISO [INITUSD,PARTIUSD]
 * Includes two minutes of receipt-time pre-roll for checkpoints. Consumers must enforce gaps,
 * sequence and freshness; this export never claims that every interval was observed.
 */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readReplay} from '../research/replayArchive.ts';
const [dir,out,start,end,list]=process.argv.slice(2),from=Date.parse(start),to=Date.parse(end);
if(!dir||!out||!Number.isFinite(from)||!Number.isFinite(to)||to<from)throw Error('usage: replay-directory output.ndjson FROM_ISO TO_ISO [symbols]');
if(path.resolve(out).startsWith(path.resolve(dir)+path.sep))throw Error('export outside the replay archive');
try{await fs.access(out);throw Error('output already exists');}catch(e:any){if(e.code!=='ENOENT')throw e;}
const tmp=out+`.${randomUUID()}.part`,h=await fs.open(tmp,'wx',0o600),symbols=list?list.split(','):[];
let count=0,gaps=0;const checkpoints:Record<string,number>={};
try{
 await h.writeFile(JSON.stringify({kind:'replay-export',version:1,from,to,preRollMs:120000,sealedOnly:true,symbols,
  coverage:'Not asserted. Preserve receipt order; ignore books before observed checkpoints or across gaps. Public depth does not prove our maker queue position.'})+'\n');
 let buffer='';
 for await(const row of readReplay(dir,{from:Math.max(0,from-120000),to,symbols})){
  count++;if(row.kind==='gap')gaps++;if(['snapshot','checkpoint'].includes(row.kind))checkpoints[row.symbol]??=row.receivedAt;
  buffer+=JSON.stringify(row)+'\n';if(buffer.length>=1024**2){await h.writeFile(buffer);buffer='';}
 }
 if(buffer)await h.writeFile(buffer);await h.sync();await h.close();
 // Exclusive final creation: do not overwrite another user's export in a race.
 await fs.link(tmp,out);await fs.unlink(tmp);
 console.log(JSON.stringify({output:out,events:count,gapRecords:gaps,firstCheckpoint:checkpoints,sealedOnly:true}));
}catch(e){await h.close().catch(()=>{});await fs.unlink(tmp).catch(()=>{});throw e;}
