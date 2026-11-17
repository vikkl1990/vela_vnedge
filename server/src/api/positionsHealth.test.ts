import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {App} from '../app.ts';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {openPosition} from '../paper/logic.ts';
import {initEntryExecution} from '../paper/entryExecution.ts';
import {positionsHealthReader} from './positionsHealth.ts';
test('health endpoint is read-only, uses cached depth and refuses a recycled entry receipt',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());initEntryExecution(db);
 db.run('CREATE TABLE funding_settlements(symbol TEXT,at INTEGER,status TEXT)');
 const now=Date.now(),cfg={...DEFAULT_CONFIG.paper,slippageBps:0,fundingCharges:true};
 const p=openPosition({id:1,scannerId:'s',scannerName:'s',symbol:'ETHUSD',tf:'15m',side:'long',qty:5,contractValue:1,entryPrice:100,at:now-10000,sl:95,tp:[],riskAmount:26,levelsSource:'script',signalId:null,cfg,bt:false});
 db.run("INSERT INTO entry_fill_evidence(position_id,order_id,book,at,role,qty,price) VALUES(1,1,0,?,'taker',5,100)",now-20000);
 db.run("INSERT INTO funding_settlements VALUES('ETHUSD',?,'unresolved')",now-1000);
 const book={receivedAt:now,exchangeAt:now,bids:[{price:102,size:10}],asks:[{price:103,size:10}]};
 let coverageReads=0;
 const fake={db,paper:{openPositions:()=>[p],advisoryObservation:()=>({config:cfg})},
  tradeMonitor:{depth:{recorder:{bookAt:()=>({...book,receivedAt:now-2000,exchangeAt:now-2000})}}},depthRecorder:{bookAt:()=>book},
  replayArchive:{broad:{coverage:()=>{coverageReads++;return {capturing:true,segments:0,from:null,to:null,checkpoints:0,segmentsWithGaps:0,failures:0,dropped:0};}}}} as unknown as App;
 const read=positionsHealthReader(fake),before=db.get<{n:number}>('SELECT total_changes() n')!.n,original=structuredClone(p);
 const result=read().positions[0];
 assert.notEqual(result.closeNow.netUsd,null);assert.equal(result.coverage.entry,'missing');assert.equal(result.coverage.pendingFunding,1);
 read();assert.equal(coverageReads,1);assert.equal(db.get<{n:number}>('SELECT total_changes() n')!.n,before);assert.deepEqual(p,original);
});
