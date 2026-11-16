import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ConfigStore} from '../src/config.ts';
import {Db} from '../src/db.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const mode=(file:string)=>fs.statSync(file).mode&0o777;

test('config replacement stays private under an ordinary operator umask',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vn-permissions-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json');fs.writeFileSync(file,'{}',{mode:0o644});
  const cfg=new ConfigStore(file),before=structuredClone(cfg.get());
  const mask=process.umask(0o022);
  try{cfg.update({ops:{...before.ops}});}finally{process.umask(mask);}
  assert.equal(mode(file),0o600);assert.deepEqual(cfg.get(),before);
  assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')).length,0);
});

test('database, WAL and snapshots are private even outside the service',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vn-sql-permissions-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'journal.db'),mask=process.umask(0o022);
  try{
    const db=new Db(file);
    try{
      db.kvSet('proof',{value:42});
      for(const suffix of ['', '-wal','-shm'])assert.equal(mode(file+suffix),0o600);
      const snapshot=db.backup(path.join(dir,'backups'),14);
      assert.equal(mode(snapshot.file),0o600);assert.equal(mode(path.dirname(snapshot.file)),0o700);
      assert.equal(db.integrityCheck(),'ok');
    }finally{db.db.close();}
  }finally{process.umask(mask);}
});

test('service wrapper appends without losing logs and creates private files',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vn-service-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=path.join(root,'ops/service-entrypoint.sh'),env={...process.env,VNEDGE_DATA_DIR:dir};
  const run=()=>spawnSync('bash',[script,'vnedge','bash','-c','printf "out\\n"; printf "err\\n" >&2; umask'],{env,encoding:'utf8'});
  assert.equal(run().status,0);assert.equal(run().status,0);
  const out=path.join(dir,'logs/vnedge.out'),err=path.join(dir,'logs/vnedge.err');
  assert.equal(mode(out),0o600);assert.equal(mode(err),0o600);
  assert.equal(fs.readFileSync(out,'utf8'),'out\n0077\nout\n0077\n');
  assert.equal(fs.readFileSync(err,'utf8'),'err\nerr\n');
});

test('service wrapper refuses a symlinked log instead of writing its target',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vn-service-link-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'logs'));const target=path.join(dir,'outside');fs.writeFileSync(target,'unchanged');
  fs.symlinkSync(target,path.join(dir,'logs/vnedge.out'));
  const run=spawnSync('bash',[path.join(root,'ops/service-entrypoint.sh'),'vnedge','bash','-c','echo changed'],{env:{...process.env,VNEDGE_DATA_DIR:dir},encoding:'utf8'});
  assert.notEqual(run.status,0);assert.equal(fs.readFileSync(target,'utf8'),'unchanged');
});
