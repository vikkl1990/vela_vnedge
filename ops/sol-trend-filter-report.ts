#!/usr/bin/env node
/** Read-only prospective study results. Never opens orders or changes configuration. */
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {solFilterResults} from '../server/src/research/solTrendFilterStudy.ts';
const file=process.env.VNEDGE_DB??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/vnedge.db');
const db=new DatabaseSync(file,{readOnly:true});
try{
 const reader={all:<T>(sql:string,...params:SQLInputValue[])=>db.prepare(sql).all(...params) as T[]};
 console.log(JSON.stringify({at:Date.now(),...solFilterResults(reader)},null,2));
}finally{db.close();}
