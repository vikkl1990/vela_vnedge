import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ConnectionError} from '../connections/delta.ts';
import {validBotToken} from './client.ts';

export type TelegramBinding={chatId:string;userId:string;username:string|null;name:string;approvedAt:number;verifiedAt:number|null};
export type TelegramCredentials={version:1;revision:string;botToken:string;botId:number;username:string;ownerId:number;savedAt:number;controlsEnabled:boolean;binding:TelegramBinding|null};

/** Credentials are outside config, policy fingerprints and database backups. */
export class TelegramStore {
  private dir:string;private file:string;
  constructor(dataDir:string){this.dir=path.join(dataDir,'secrets');this.file=path.join(this.dir,'telegram-connection.json');}
  private safe(s:fs.Stats,dir=false){
    if(s.isSymbolicLink()||!(dir?s.isDirectory():s.isFile())||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw Error('unsafe');
  }
  private directory(create=false){
    if(create)try{fs.mkdirSync(this.dir,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}
    try{this.safe(fs.lstatSync(this.dir),true);return true;}catch(e:any){if(e.code==='ENOENT')return false;throw e;}
  }
  private access<T>(fn:()=>T):T{
    try{return fn();}catch{throw new ConnectionError(503,'Telegram credential storage unavailable. Check the private secrets directory and file permissions.');}
  }
  read():TelegramCredentials|null{return this.access(()=>{
    if(!this.directory())return null;
    let fd:number;
    try{fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}
    try{
      const stat=fs.fstatSync(fd);this.safe(stat);if(stat.size>8192)throw Error('oversize');
      const c=JSON.parse(fs.readFileSync(fd,'utf8')) as TelegramCredentials;
      validBotToken(c.botToken);
      if(c.version!==1||typeof c.revision!=='string'||!Number.isSafeInteger(c.botId)||c.botId<=0||!Number.isSafeInteger(c.ownerId)||c.ownerId<=0||!Number.isFinite(c.savedAt)||typeof c.controlsEnabled!=='boolean'||!/^[A-Za-z0-9_]{5,64}$/.test(c.username))throw Error('invalid');
      if(c.binding&&(!/^\d{1,16}$/.test(c.binding.chatId)||c.binding.chatId!==c.binding.userId||!Number.isFinite(c.binding.approvedAt)||!(c.binding.verifiedAt===null||Number.isFinite(c.binding.verifiedAt))))throw Error('invalid binding');
      return c;
    }finally{fs.closeSync(fd);}
  });}
  write(c:TelegramCredentials){this.access(()=>{
    this.directory(true);
    try{this.safe(fs.lstatSync(this.file));}catch(e:any){if(e.code!=='ENOENT')throw e;}
    const temp=path.join(this.dir,`.${randomUUID()}.tmp`);let fd:number|undefined;
    try{
      fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(c));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temp,this.file);
      const directory=fs.openSync(this.dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{/* renamed */}}
  });}
  remove(){this.access(()=>{
    if(!this.directory())return;
    try{this.safe(fs.lstatSync(this.file));fs.unlinkSync(this.file);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  });}
}
