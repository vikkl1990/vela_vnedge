import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import type {Db} from '../db.ts';
import type {AlertManager,TelegramTarget} from '../ops/alerts.ts';
import {ConnectionError} from '../connections/delta.ts';
import {telegramClient,validBotToken,type TelegramCall} from './client.ts';
import {TelegramStore,type TelegramCredentials,type TelegramBinding} from './store.ts';
import type {TelegramActions} from './commands.ts';

type Person={id:number;is_bot?:boolean;username?:string;first_name?:string;last_name?:string};
export type TelegramUpdate={update_id:number;message?:{message_id:number;date:number;text?:string;from?:Person;chat:{id:number;type:string};forward_origin?:unknown;via_bot?:unknown;sender_chat?:unknown}};
type Candidate=Omit<TelegramBinding,'approvedAt'|'verifiedAt'>;
type Pairing={id:string;hash:Buffer;expiresAt:number;revision:string;ownerId:number;candidate:Candidate|null};
type Confirmation={revision:string;chatId:string;userId:string;expiresAt:number;action:'resume'|'close';positionId?:number;key:string};
type Options={db:Db;dataDir:string;actions:TelegramActions;ownerActive:(id:number)=>boolean;alerts:()=>AlertManager;
  fallbackTarget?:()=>TelegramTarget|null;manageDelivery?:boolean;now?:()=>number;client?:(token:string)=>TelegramCall};
const COMMANDS=[
  ['status','Bot mode, equity, entries and feed'],['positions','Open paper positions and IDs'],
  ['pnl','Today’s closed paper results after fees'],['alerts','Active operational alerts'],
  ['pause','Pause paper entries'],['resume','Request manual-pause release'],
  ['close','Request closure: /close POSITION_ID'],['confirm','Confirm a pending action'],
  ['cancel','Cancel pending command confirmations'],['help','Commands and safeguards'],
].map(([command,description])=>({command,description}));
const digest=(s:string)=>createHash('sha256').update(s).digest();
const errorText=(e:unknown)=>e instanceof ConnectionError?e.message:'Telegram operation failed. Check the dashboard.';

/** One private chat, one approved Telegram user and one active dashboard admin.
 * Updates are durably consumed before actions (at most once); confirmations are
 * short-lived and never survive restarts. The command set has no live arming,
 * arbitrary config, shell, promotion, entry placement or loss-reset capability. */
export class TelegramControl {
  private store:TelegramStore;private d:Options;private now:()=>number;private client:(token:string)=>TelegramCall;
  private running=false;private loop:Promise<void>|null=null;private abort:AbortController|null=null;
  private pairing:Pairing|null=null;private confirmations=new Map<string,Confirmation>();
  private startedAt:number;private busy=false;private lastSetupAt=-Infinity;
  private lastPollAt:number|null=null;private lastError:string|null=null;
  private commandTimes:number[]=[];
  constructor(d:Options){
    this.d=d;this.store=new TelegramStore(d.dataDir);this.now=d.now??Date.now;this.client=d.client??telegramClient;this.startedAt=Math.ceil(this.now()/1000)*1000;
    d.db.db.exec(`CREATE TABLE IF NOT EXISTS telegram_command_audit(
      bot_id INTEGER NOT NULL,update_id INTEGER NOT NULL,at INTEGER NOT NULL,user_id TEXT NOT NULL,
      command TEXT NOT NULL,status TEXT NOT NULL,result TEXT,
      PRIMARY KEY(bot_id,update_id));`);
  }
  private credentials(){return this.store.read();}
  private active(c:TelegramCredentials){return this.d.ownerActive(c.ownerId);}
  deliveryTarget():TelegramTarget|null{
    try{
      const c=this.credentials();
      if(!c)return this.d.fallbackTarget?.()??null;
      return c.binding?.verifiedAt&&this.active(c)?{botToken:c.botToken,chatId:c.binding.chatId}:null;
    }catch{return null;}
  }
  private refreshDelivery(){if(this.d.manageDelivery!==false)this.d.alerts().configure({telegram:this.deliveryTarget()});}
  status(){
    const c=this.credentials(),active=!!c&&this.active(c);
    if(this.pairing&&this.pairing.expiresAt<=this.now())this.pairing=null;
    return {configured:!!c,ready:!!c?.binding?.verifiedAt&&active,username:c?.username??null,savedAt:c?.savedAt??null,
      binding:c?.binding??null,controlsEnabled:c?.controlsEnabled??false,ownerActive:active,
      mode:this.d.actions.mode(),receiverRunning:!!this.loop,lastPollAt:this.lastPollAt,lastError:this.lastError,
      pairing:this.pairing?{id:this.pairing.id,expiresAt:this.pairing.expiresAt,candidate:this.pairing.candidate}:null,
      recent:c?this.d.db.all<{at:number;command:string;status:string;result:string|null}>('SELECT at,command,status,result FROM telegram_command_audit WHERE bot_id=? ORDER BY at DESC,update_id DESC LIMIT 20',c.botId):[]};
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new ConnectionError(409,'A Telegram setup action is already running.');
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  async save(input:unknown,ownerId:number){
    return this.exclusive(async()=>{
      if(!this.d.ownerActive(ownerId))throw new ConnectionError(403,'An active administrator is required.');
      if(this.now()-this.lastSetupAt<5000)throw new ConnectionError(429,'Wait five seconds between connection attempts.');
      const body=input as {botToken?:unknown}|null,token=validBotToken(body?.botToken);this.lastSetupAt=this.now();
      const call=this.client(token);
      const me=await call<Person>('getMe'),hook=await call<{url:string}>('getWebhookInfo');
      if(!me.is_bot||!Number.isSafeInteger(me.id)||me.id<=0||!me.username||!/^[A-Za-z0-9_]{5,64}$/.test(me.username))throw new ConnectionError(502,'Telegram returned an invalid bot identity.');
      if(hook.url)throw new ConnectionError(409,'This bot has an existing webhook. Use a dedicated bot or remove that webhook before connecting.');
      await this.stopLoop();
      this.store.write({version:1,revision:randomUUID(),botToken:token,botId:me.id,username:me.username,ownerId,savedAt:this.now(),controlsEnabled:true,binding:null});
      this.pairing=null;this.confirmations.clear();this.lastError=null;this.startedAt=Math.ceil(this.now()/1000)*1000;
      this.refreshDelivery();this.launch();return this.status();
    });
  }
  beginPair(ownerId:number){
    if(this.busy)throw new ConnectionError(409,'A Telegram setup action is already running.');
    const c=this.credentials();if(!c)throw new ConnectionError(400,'Save a bot token first.');
    if(c.ownerId!==ownerId||!this.active(c))throw new ConnectionError(403,'Only the administrator who saved this bot may pair it.');
    const token=randomBytes(24).toString('base64url');
    this.pairing={id:randomUUID(),hash:digest(token),expiresAt:this.now()+300000,revision:c.revision,ownerId,candidate:null};
    return {url:`https://t.me/${c.username}?start=${token}`,expiresAt:this.pairing.expiresAt,status:this.status()};
  }
  async approvePair(input:unknown,ownerId:number){
    return this.exclusive(async()=>{
      const c=this.credentials(),pair=this.pairing,body=input as {pairId?:unknown}|null;
      if(!c||!pair||pair.id!==body?.pairId||pair.expiresAt<=this.now()||pair.revision!==c.revision||!pair.candidate)throw new ConnectionError(409,'Pairing expired or no private chat has connected. Start pairing again.');
      if(c.ownerId!==ownerId||pair.ownerId!==ownerId||!this.active(c))throw new ConnectionError(403,'Only the owning administrator may approve this chat.');
      c.binding={...pair.candidate,approvedAt:this.now(),verifiedAt:null};this.store.write(c);
      this.pairing=null;this.confirmations.clear();this.refreshDelivery();
      await this.sendTest(c);
      try{await this.client(c.botToken)('setMyCommands',{scope:{type:'chat',chat_id:c.binding.chatId},commands:COMMANDS});}catch(e){this.lastError=errorText(e);}
      return this.status();
    });
  }
  private async sendTest(c:TelegramCredentials){
    if(!c.binding||!this.active(c))throw new ConnectionError(400,'Approve a private chat first.');
    try{
      await this.client(c.botToken)('sendMessage',{chat_id:c.binding.chatId,text:'VN EDGE connected. Alerts are enabled for this private chat. Use /help for commands. Paper mode and risk settings are unchanged.',protect_content:true});
      const current=this.credentials();
      if(!current||current.revision!==c.revision||current.binding?.userId!==c.binding.userId)throw new ConnectionError(409,'Connection changed during the test.');
      current.binding.verifiedAt=this.now();this.store.write(current);this.lastError=null;this.refreshDelivery();
    }catch(e){this.lastError=errorText(e);throw e;}
  }
  async test(){return this.exclusive(async()=>{
    const c=this.credentials();if(!c)throw new ConnectionError(400,'Save a bot token first.');
    if(this.now()-this.lastSetupAt<5000)throw new ConnectionError(429,'Wait five seconds between connection tests.');
    this.lastSetupAt=this.now();await this.sendTest(c);return this.status();
  });}
  controls(enabled:unknown){
    if(this.busy)throw new ConnectionError(409,'A Telegram setup action is already running.');
    if(typeof enabled!=='boolean')throw new ConnectionError(400,'Choose whether paper controls are enabled.');
    const c=this.credentials();if(!c)throw new ConnectionError(400,'Save a bot token first.');
    c.controlsEnabled=enabled;this.store.write(c);this.confirmations.clear();return this.status();
  }
  async remove(){return this.exclusive(async()=>{
    await this.stopLoop();this.store.remove();this.pairing=null;this.confirmations.clear();this.lastError=null;this.refreshDelivery();return this.status();
  });}
  start(){this.running=true;this.startedAt=Math.ceil(this.now()/1000)*1000;this.refreshDelivery();this.launch();}
  async stop(){this.running=false;this.confirmations.clear();this.pairing=null;await this.stopLoop();}
  private async stopLoop(){this.abort?.abort();try{await this.loop;}catch{/* sanitized below */}this.loop=null;this.abort=null;}
  private launch(){
    if(!this.running||this.loop)return;
    let c:TelegramCredentials|null;try{c=this.credentials();}catch(e){this.lastError=errorText(e);return;}if(!c)return;
    const controller=new AbortController();this.abort=controller;
    this.loop=this.poll(c,controller.signal).finally(()=>{this.loop=null;});
  }
  private cursor(botId:number){return this.d.db.kvGet<{next:number;at:number}>(`telegram.cursor.${botId}`)??{next:0,at:this.now()};}
  private async poll(c:TelegramCredentials,signal:AbortSignal){
    const call=this.client(c.botToken);
    while(!signal.aborted){
      try{
        const cursor=this.cursor(c.botId);
        const updates=await call<TelegramUpdate[]>('getUpdates',{offset:this.now()-cursor.at>=7*86400000?0:cursor.next,timeout:20,limit:50,allowed_updates:['message']},signal);
        if(signal.aborted)return;
        if(!Array.isArray(updates))throw new ConnectionError(502,'Telegram returned invalid updates.');
        this.lastPollAt=this.now();this.lastError=null;this.refreshDelivery();
        for(const update of [...updates].sort((a,b)=>a.update_id-b.update_id)){
          if(signal.aborted)return;
          await this.receive(update,c.revision);
        }
      }catch(e){
        if(signal.aborted)return;
        this.lastError=errorText(e);
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);timer.unref();signal.addEventListener('abort',done,{once:true});});
      }
    }
  }
  /** Public for recorded-update tests; production input comes only from getUpdates. */
  async receive(update:TelegramUpdate,revision?:string){
    const c=this.credentials();if(!c||(revision&&revision!==c.revision)||!Number.isSafeInteger(update.update_id)||update.update_id<0)return;
    const cursor=this.cursor(c.botId);
    if(update.update_id<cursor.next&&this.now()-cursor.at<7*86400000)return;
    // Persist before any side effect: a restarted process never repeats a command.
    this.d.db.kvSet(`telegram.cursor.${c.botId}`,{next:update.update_id+1,at:this.now()});
    const m=update.message,from=m?.from;
    if(!m||!from||from.is_bot||m.chat.type!=='private'||m.chat.id!==from.id||!Number.isSafeInteger(from.id)||from.id<=0||m.forward_origin||m.via_bot||m.sender_chat||!Number.isFinite(m.date))return;
    const age=this.now()-m.date*1000;
    if(age>90000||age< -5000||m.date*1000<this.startedAt||!this.active(c))return;
    if(typeof m.text!=='string'||m.text.length>256)return;
    const match=m.text.trim().match(/^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([^\n]+))?$/);
    if(!match||(match[2]&&match[2].toLowerCase()!==c.username.toLowerCase()))return;
    const command=match[1],arg=(match[3]??'').trim(),userId=String(from.id),chatId=String(m.chat.id);
    if(command==='start'&&arg&&this.pairing){
      const pair=this.pairing;
      if(pair.expiresAt>this.now()&&pair.revision===c.revision&&!pair.candidate&&timingSafeEqual(digest(arg),pair.hash)){
        pair.candidate={chatId,userId,username:from.username??null,name:[from.first_name,from.last_name].filter(Boolean).join(' ').slice(0,128)};
        await this.reply(c,chatId,'Private chat received. Return to VN EDGE Settings and approve this chat to enable alerts and commands.');
      }
      return;
    }
    if(!c.binding?.verifiedAt||c.binding.chatId!==chatId||c.binding.userId!==userId)return;
    this.commandTimes=this.commandTimes.filter(t=>this.now()-t<60000);
    // A status-message burst must never disable the protective pause command.
    if(this.commandTimes.length>=20&&command!=='pause')return;
    if(this.commandTimes.length<20)this.commandTimes.push(this.now());
    if(this.d.db.get('SELECT 1 FROM telegram_command_audit WHERE bot_id=? AND update_id=?',c.botId,update.update_id))return;
    const known=['status','positions','pnl','alerts','pause','resume','close','confirm','cancel','help','start'].includes(command);
    this.d.db.run("INSERT INTO telegram_command_audit(bot_id,update_id,at,user_id,command,status) VALUES(?,?,?,?,?,'claimed')",c.botId,update.update_id,this.now(),userId,known?command:'unsupported');
    let result:string,status='done';
    try{result=this.command(c,command,arg,chatId,userId);}catch{status='failed';result='Command could not complete. Check the dashboard before retrying.';}
    this.d.db.run('UPDATE telegram_command_audit SET status=?,result=? WHERE bot_id=? AND update_id=?',status,result.replace(/\/confirm [a-f0-9]+/g,'/confirm <one-time code>').slice(0,300),c.botId,update.update_id);
    await this.reply(c,chatId,result);
  }
  private command(c:TelegramCredentials,command:string,arg:string,chatId:string,userId:string):string{
    for(const [id,p]of this.confirmations)if(p.expiresAt<=this.now())this.confirmations.delete(id);
    if(['status','positions','pnl','alerts'].includes(command)&&!arg)return this.d.actions.read(command as 'status'|'positions'|'pnl'|'alerts');
    if(['start','help'].includes(command))return 'VN EDGE private control\n/status · /positions · /pnl · /alerts\n/pause pauses paper entries immediately.\n/resume clears only a manual pause after confirmation.\n/close ID requests a paper close after confirmation.\n/confirm CODE confirms within 60 seconds.\n/cancel cancels pending confirmations.\nLive activation, risk overrides and new orders are unavailable.';
    if(command==='cancel'&&!arg){this.confirmations.clear();return 'Pending command confirmations cancelled. Trading orders are unchanged.';}
    if(!c.controlsEnabled)return 'Paper controls are disabled in Settings. Status commands remain available.';
    if(this.d.actions.mode()!=='paper')return 'Telegram trade controls are available only in paper mode.';
    if(command==='pause'&&!arg){this.confirmations.clear();return this.d.actions.pause();}
    if(command==='confirm'){
      const p=this.confirmations.get(arg);this.confirmations.delete(arg);
      if(!p||p.expiresAt<=this.now()||p.revision!==c.revision||p.chatId!==chatId||p.userId!==userId)return 'Confirmation is invalid or expired. Request the action again.';
      if(p.action==='resume'){
        if(this.d.actions.resumeKey()!==p.key)return 'Pause state changed. Request /resume again.';
        return this.d.actions.resume();
      }
      return this.d.actions.close(p.positionId!,p.key);
    }
    let action:'resume'|'close',key:string,text:string,positionId:number|undefined;
    if(command==='resume'&&!arg){action='resume';key=this.d.actions.resumeKey();text='Clear the manual paper pause? Active daily/weekly loss limits and all entry gates remain enforced.';}
    else if(command==='close'&&/^[1-9]\d{0,14}$/.test(arg)){
      action='close';positionId=Number(arg);const p=this.d.actions.closePreview(positionId);
      if(!p)return 'No open paper position with that ID.';key=p.key;text=p.text;
    }else return 'Unknown command or arguments. Use /help.';
    const token=randomBytes(12).toString('hex');
    this.confirmations.clear();this.confirmations.set(token,{revision:c.revision,chatId,userId,expiresAt:this.now()+60000,action,positionId,key});
    return `${text}\nConfirm within 60 seconds: /confirm ${token}`;
  }
  private async reply(c:TelegramCredentials,chatId:string,text:string){
    try{await this.client(c.botToken)('sendMessage',{chat_id:chatId,text:text.slice(0,3900),protect_content:true});}
    catch(e){this.lastError=errorText(e);}
  }
}
