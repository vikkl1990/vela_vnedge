import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Db} from '../db.ts';
import {AlertManager} from '../ops/alerts.ts';
import {TelegramControl,type TelegramUpdate} from './control.ts';
import {TelegramStore} from './store.ts';
import {telegramClient,type TelegramCall} from './client.ts';
import {ConnectionError} from '../connections/delta.ts';
import type {TelegramActions} from './commands.ts';
import {stopDescription} from './commands.ts';
import {telegramRoutes} from './routes.ts';
import {permissionFor} from '../auth/routes.ts';

const TOKEN='123456789:'+ 'a'.repeat(35);
test('VVV profit is described as unlocked until the bound trailing threshold is reached',()=>{
  const text=stopDescription({side:'long',entryPrice:19.591,sl:18.815,slOriginal:18.815,protection:{trailAfterR:.5,peakR:.4252577319587608}});
  assert.match(text,/profit not locked/);assert.match(text,/19.979/);assert.match(text,/peak \+0.43R/);
  assert.match(stopDescription({side:'short',entryPrice:100,sl:105,slOriginal:105,protection:{trailAfterR:.5,peakR:.4}}),/97.5/);
});
async function fixture(t:TestContext,paired=true){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vn-telegram-')),db=new Db(':memory:');
  let now=1800000000000,active=true,mode='paper',failSend=false,webhook='',pauseKey='pause-1',closeKey='position-1';
  const sent:Array<{text:string;chat_id:string}>=[],calls:string[]=[],actions:string[]=[];
  const alerts=new AlertManager({repeatMinutes:60,maxPerHour:30});
  const command:TelegramActions={mode:()=>mode,read:c=>'report '+c,pause:()=>{actions.push('pause');return 'paused';},
    resumeKey:()=>pauseKey,resume:()=>{actions.push('resume');return 'resumed';},
    closePreview:id=>id===7?{key:closeKey,text:'Close paper #7?'}:null,
    close:(id,key)=>{if(key!==closeKey)return 'Position changed';actions.push('close '+id);return 'closure requested';}};
  const call:TelegramCall=async <T>(method:string,body:Record<string,unknown>={})=>{
    calls.push(method);
    if(method==='getMe')return {id:123456789,is_bot:true,username:'vn_edge_test_bot'} as T;
    if(method==='getWebhookInfo')return {url:webhook} as T;
    if(method==='sendMessage'){if(failSend)throw new ConnectionError(502,'Telegram request failed.');sent.push(body as typeof sent[number]);}
    return true as T;
  };
  const options={dataDir:dir,db,actions:command,ownerActive:()=>active,alerts:()=>alerts,now:()=>now,client:()=>call};
  const bot=new TelegramControl(options);
  t.after(async()=>{await bot.stop();db.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await bot.save({botToken:TOKEN},1);
  let id=1;
  const update=(text:string,overrides:Partial<NonNullable<TelegramUpdate['message']>>={}):TelegramUpdate=>({update_id:id++,message:{message_id:id,date:Math.floor(now/1000),text,from:{id:42,first_name:'Owner',username:'owner'},chat:{id:42,type:'private'},...overrides}});
  const receive=async(text:string,override:Partial<NonNullable<TelegramUpdate['message']>>={})=>bot.receive(update(text,override));
  if(paired){
    const pair=bot.beginPair(1);await receive('/start '+new URL(pair.url).searchParams.get('start'));
    assert.equal(bot.status().ready,false);assert.equal(alerts.configured,false);
    await bot.approvePair({pairId:bot.status().pairing!.id},1);
  }
  const confirmation=()=>sent.at(-1)!.text.match(/\/confirm ([a-f0-9]+)/)![1];
  return {dir,db,bot,sent,calls,actions,alerts,options,command,update,receive,confirmation,
    advance:(n:number)=>{now+=n;},owner:(v:boolean)=>{active=v;},mode:(v:string)=>{mode=v;},fail:(v:boolean)=>{failSend=v;},hook:(s:string)=>{webhook=s;},pauseKey:(s:string)=>{pauseKey=s;},closeKey:(s:string)=>{closeKey=s;}};
}

test('save is private, metadata-only and requires explicit private-chat approval and successful delivery',async t=>{
  const f=await fixture(t,false);
  const file=path.join(f.dir,'secrets/telegram-connection.json');
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
  assert(!JSON.stringify(f.bot.status()).includes(TOKEN));
  const pair=f.bot.beginPair(1),token=new URL(pair.url).searchParams.get('start')!;
  await f.receive('/start wrong');assert.equal(f.bot.status().pairing?.candidate,null);
  await f.receive('/start '+token,{chat:{id:-99,type:'group'}});assert.equal(f.bot.status().pairing?.candidate,null);
  await f.receive('/start '+token);assert.equal(f.bot.status().pairing?.candidate?.userId,'42');
  await assert.rejects(f.bot.approvePair({pairId:f.bot.status().pairing!.id},2),/owning administrator/);
  f.fail(true);await assert.rejects(f.bot.approvePair({pairId:f.bot.status().pairing!.id},1));
  assert.equal(f.bot.status().ready,false);assert.equal(f.alerts.configured,false);
  f.fail(false);f.advance(6000);await f.bot.test();assert.equal(f.bot.status().ready,true);assert.equal(f.alerts.configured,true);
});
test('unauthorized, group, forwarded, bot, stale, edited and foreign-bot commands cannot execute',async t=>{
  const f=await fixture(t);const base=f.sent.length;
  await f.receive('/pause',{from:{id:43},chat:{id:43,type:'private'}});
  await f.receive('/pause',{chat:{id:-42,type:'group'}});
  await f.receive('/pause',{forward_origin:{type:'user'}});
  await f.receive('/pause',{from:{id:42,is_bot:true}});
  await f.receive('/pause',{via_bot:{id:999}});
  await f.receive('/pause',{date:Math.floor(f.options.now()/1000)-100});
  await f.receive('/pause',{date:Math.floor(f.options.now()/1000)+10});
  await f.receive('/pause@another_bot');
  await f.bot.receive({update_id:100,edited_message:f.update('/pause').message} as unknown as TelegramUpdate);
  assert.deepEqual(f.actions,[]);assert.equal(f.sent.length,base);
});
test('read commands work, mutations require paper mode and controls switch',async t=>{
  const f=await fixture(t);
  for(const c of ['status','positions','pnl','alerts'])await f.receive('/'+c);
  assert(f.sent.some(x=>x.text==='report positions'));
  f.mode('production');await f.receive('/pause');assert.deepEqual(f.actions,[]);
  f.mode('paper');f.bot.controls(false);await f.receive('/pause');assert.deepEqual(f.actions,[]);
  await f.receive('/status');assert.equal(f.sent.at(-1)?.text,'report status');
  f.bot.controls(true);await f.receive('/pause');assert.deepEqual(f.actions,['pause']);
});
test('resume and close require one-use confirmations bound to state; no nonce enters audit records',async t=>{
  const f=await fixture(t);
  await f.receive('/resume');const first=f.confirmation();assert.deepEqual(f.actions,[]);
  const audit=JSON.stringify(f.db.all('SELECT * FROM telegram_command_audit'));assert(!audit.includes(first));
  await f.receive('/confirm '+first);await f.receive('/confirm '+first);assert.deepEqual(f.actions,['resume']);
  await f.receive('/close 7');const close=f.confirmation();await f.receive('/confirm '+close);assert.deepEqual(f.actions,['resume','close 7']);
  await f.receive('/resume');const changed=f.confirmation();f.pauseKey('pause-2');await f.receive('/confirm '+changed);assert.equal(f.actions.length,2);
  await f.receive('/close 7');const partial=f.confirmation();f.closeKey('partial-exit');await f.receive('/confirm '+partial);assert.equal(f.actions.length,2);
});
test('status rate limiting cannot block an authorized protective pause',async t=>{
  const f=await fixture(t);
  for(let i=0;i<25;i++)await f.receive('/status');
  await f.receive('/pause');assert.deepEqual(f.actions,['pause']);
});
test('confirmations expire, cancel and are invalidated when controls are disabled',async t=>{
  const f=await fixture(t);
  await f.receive('/close 7');const one=f.confirmation();f.advance(61000);await f.receive('/confirm '+one);
  await f.receive('/resume');const two=f.confirmation();await f.receive('/cancel');await f.receive('/confirm '+two);
  await f.receive('/resume');const three=f.confirmation();f.bot.controls(false);f.bot.controls(true);await f.receive('/confirm '+three);
  assert.deepEqual(f.actions,[]);
});
test('duplicate delivery and failed replies never repeat a critical command',async t=>{
  const f=await fixture(t),u=f.update('/pause');f.fail(true);
  await f.bot.receive(u);await f.bot.receive(u);assert.deepEqual(f.actions,['pause']);
  assert.equal(f.db.get<{status:string}>('SELECT status FROM telegram_command_audit WHERE update_id=?',u.update_id)?.status,'done');
  f.fail(false);const restarted=new TelegramControl(f.options);await restarted.receive(u);assert.equal(f.actions.length,1);
  await restarted.stop();
});
test('restart drops downtime messages and pending confirmations; role revocation fails closed',async t=>{
  const f=await fixture(t);await f.receive('/resume');const token=f.confirmation(),duringDowntime=f.update('/pause');
  f.advance(20000);const restarted=new TelegramControl(f.options);
  await restarted.receive(duringDowntime);await restarted.receive(f.update('/confirm '+token));assert.deepEqual(f.actions,[]);
  f.owner(false);await restarted.receive(f.update('/pause'));assert.equal(restarted.deliveryTarget(),null);assert.deepEqual(f.actions,[]);
  await restarted.stop();
});
test('a changed bot token or expired pairing link cannot authorize the old claimant',async t=>{
  const f=await fixture(t,false),pair=f.bot.beginPair(1);f.advance(301000);
  await f.receive('/start '+new URL(pair.url).searchParams.get('start'));assert.equal(f.bot.status().pairing,null);
  const second=f.bot.beginPair(1);f.advance(6000);await f.bot.save({botToken:TOKEN},1);
  await f.receive('/start '+new URL(second.url).searchParams.get('start'));assert.equal(f.bot.status().binding,null);
});
test('an existing webhook refuses replacement and preserves the current working connection',async t=>{
  const f=await fixture(t);f.hook('https://other.invalid/hook');f.advance(6000);
  await assert.rejects(f.bot.save({botToken:TOKEN},1),/existing webhook/);
  assert.equal(f.bot.status().ready,true);
});
test('credential store rejects readable files and symlinks without leaking their contents',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'secrets/telegram-connection.json');
  fs.chmodSync(file,0o644);assert.throws(()=>f.bot.status(),e=>e instanceof Error&&!e.message.includes(TOKEN)&&/storage unavailable/.test(e.message));
  fs.chmodSync(file,0o600);fs.renameSync(file,file+'.old');fs.symlinkSync(file+'.old',file);
  assert.throws(()=>new TelegramStore(f.dir).read(),/storage unavailable/);
});
test('Telegram API logical errors and network errors are redacted even with HTTP 200',async()=>{
  for(const failure of [
    async()=>new Response(JSON.stringify({ok:false,error_code:403,description:TOKEN}),{status:200}),
    async()=>{throw Error('https://api.telegram.org/bot'+TOKEN+'/sendMessage');},
  ]){
    await assert.rejects(telegramClient(TOKEN,failure as typeof fetch)('sendMessage'),e=>e instanceof Error&&!e.message.includes(TOKEN)&&!e.message.includes('api.telegram.org'));
  }
});
test('all Telegram routes require administrator and secure same-origin transport',async t=>{
  const f=await fixture(t),routes=new Map<string,Function>();
  telegramRoutes((method,route,handler)=>routes.set(method+' '+route,handler),f.bot,()=>({id:1,role:'admin',disabled:false} as never));
  for(const [key,handler]of routes){
    const [method,route]=key.split(' ');assert.equal(permissionFor(method,route),'admin');
    assert.throws(()=>handler({method,headers:{host:'bot.example','content-type':'application/json'},socket:{remoteAddress:'203.0.113.1'}},{setHeader(){}},{},new URL('https://bot.example'+route),{}),/HTTPS/);
  }
});
test('long polling uses durable offsets, only messages, and aborts on stop',async t=>{
  const f=await fixture(t);const calls:Record<string,unknown>[]=[],u=f.update('/pause');let first=true;
  const polling:TelegramCall=async <T>(method:string,body:Record<string,unknown>={},signal?:AbortSignal)=>{
    if(method!=='getUpdates')return true as T;
    calls.push(body);if(first){first=false;return [u] as T;}
    return await new Promise<T>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(Error('abort')),{once:true}));
  };
  const bot=new TelegramControl({...f.options,client:()=>polling});
  bot.start();
  for(let i=0;i<50&&calls.length<2;i++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(f.actions,['pause']);assert.equal(calls[1].offset,u.update_id+1);assert.deepEqual(calls[0].allowed_updates,['message']);
  await bot.stop();assert.equal(bot.status().receiverRunning,false);
});
