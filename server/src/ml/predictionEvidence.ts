import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Db} from '../db.ts';
import {featureVector,type Features} from './features.ts';
export const FEATURE_SCHEMA=createHash('sha256').update(readFileSync(new URL('./features.ts',import.meta.url))).digest('hex');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export interface ModelEvidence {id:string;trainedAt:number;trainingThrough:number;featureSchema:string}
export interface PredictionContext {symbol:string;tf:string;book:number;startedAt:number}
/** Audit records only. These tables never participate in training, sizing or admission. */
export class PredictionEvidence {
 private db:Db;
 constructor(db:Db){this.db=db;db.db.exec(`
  CREATE TABLE IF NOT EXISTS ml_model_versions(id TEXT PRIMARY KEY,trained_at INTEGER NOT NULL,training_through INTEGER NOT NULL,feature_schema TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ml_entry_predictions(id TEXT PRIMARY KEY,scanner_id TEXT NOT NULL,symbol TEXT NOT NULL,tf TEXT NOT NULL,book INTEGER NOT NULL,started_at INTEGER NOT NULL,predicted_at INTEGER NOT NULL,prob REAL NOT NULL,model_id TEXT,model_scope TEXT NOT NULL,feature_schema TEXT NOT NULL,features TEXT NOT NULL,features_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ml_prediction_bindings(book INTEGER NOT NULL,position_id INTEGER NOT NULL,prediction_id TEXT NOT NULL UNIQUE,policy_id TEXT NOT NULL,decision_at INTEGER NOT NULL,PRIMARY KEY(book,position_id));
 `);}
 saveModel(payload:unknown,trainedAt:number,trainingThrough:number):ModelEvidence{
  const text=JSON.stringify(payload),id=hash(JSON.stringify([trainedAt,trainingThrough,FEATURE_SCHEMA,text]));
  this.db.run('INSERT OR IGNORE INTO ml_model_versions VALUES(?,?,?,?,?)',id,trainedAt,trainingThrough,FEATURE_SCHEMA,text);
  return {id,trainedAt,trainingThrough,featureSchema:FEATURE_SCHEMA};
 }
 record(scannerId:string,f:Features,prob:number,scope:string,model:ModelEvidence|null,ctx:PredictionContext,at=Date.now()){
  const id=randomUUID(),features=JSON.stringify(featureVector(f));
  this.db.run('INSERT INTO ml_entry_predictions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,scannerId,ctx.symbol,ctx.tf,ctx.book,ctx.startedAt,at,prob,model?.id??null,scope,FEATURE_SCHEMA,features,hash(features));return id;
 }
 bind(id:string,book:number,positionId:number,policyId:string,at=Date.now()){
  this.db.run('INSERT OR IGNORE INTO ml_prediction_bindings VALUES(?,?,?,?,?)',book,positionId,id,policyId,at);
 }
 verified(since:number):Set<number>{
  const rows=this.db.all<any>(`SELECT p.id,p.fills,r.features_hash,r.prob FROM positions p
   JOIN ml_prediction_bindings b ON b.position_id=p.id AND b.book=p.bt AND b.policy_id=p.policy_id
   JOIN ml_entry_predictions r ON r.id=b.prediction_id AND r.book=p.bt AND r.scanner_id=p.scanner_id AND r.symbol=p.symbol AND r.tf=p.tf
   JOIN ml_model_versions m ON m.id=r.model_id AND m.feature_schema=r.feature_schema
   WHERE p.status='closed' AND p.exit_at>=? AND r.predicted_at>=r.started_at AND r.predicted_at<=b.decision_at
   AND m.training_through<=m.trained_at AND m.trained_at<=r.predicted_at
   AND p.entry_at>=r.started_at AND p.exit_at>=b.decision_at`,since);
  return new Set(rows.filter(r=>{try{const f=JSON.parse(r.fills);return f.mlProb===r.prob&&f.features&&hash(JSON.stringify(featureVector(f.features)))===r.features_hash;}catch{return false;}}).map(r=>r.id));
 }
}
