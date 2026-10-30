/** Import externally verified settlement data. OHLC candles alone are not settlement evidence. */
import fs from 'node:fs';
import {Db} from '../db.ts';
import {FundingJournal} from '../execution/fundingJournal.ts';
const args=process.argv.slice(2);
if(args.length!==3||args[0]!=='--apply')throw Error('usage: node server/src/cli/funding-import.ts --apply /absolute/database /absolute/verified-settlements.json');
const rows=JSON.parse(fs.readFileSync(args[2],'utf8'));
if(!Array.isArray(rows)||!rows.length||rows.length>1000)throw Error('expected 1–1000 verified settlement records');
const db=new Db(args[1]);
try{
 const journal=new FundingJournal(db);
 db.transaction(()=>{for(const r of rows)journal.verify(r.symbol,r.at,r.ratePct,r.markPrice,r.evidence);});
 console.log(`Imported ${rows.length} verified settlements; the running scheduler applies them idempotently.`);
}finally{db.db.close();}
