import type http from 'node:http';
import {protectConnectionRequest} from '../connections/routes.ts';
import {ConnectionError} from '../connections/delta.ts';
import type {User} from '../auth/store.ts';
import type {TelegramControl} from './control.ts';
type Handler=(req:http.IncomingMessage,res:http.ServerResponse,params:Record<string,string>,url:URL,body:unknown)=>unknown;
export function telegramRoutes(add:(method:string,route:string,handler:Handler)=>void,control:TelegramControl,userFor:(req:http.IncomingMessage)=>User|null){
  const guard=(handler:(body:unknown,user:User)=>unknown):Handler=>(req,res,_p,_u,body)=>{
    protectConnectionRequest(req);res.setHeader('Cache-Control','no-store');
    const user=userFor(req);if(!user||user.disabled||user.role!=='admin')throw new ConnectionError(403,'Administrator access required.');
    return handler(body,user);
  };
  add('GET','/api/connections/telegram',guard(()=>control.status()));
  add('PUT','/api/connections/telegram',guard((body,user)=>control.save(body,user.id)));
  add('DELETE','/api/connections/telegram',guard(()=>control.remove()));
  add('POST','/api/connections/telegram/pair',guard((_body,user)=>control.beginPair(user.id)));
  add('POST','/api/connections/telegram/approve',guard((body,user)=>control.approvePair(body,user.id)));
  add('POST','/api/connections/telegram/test',guard(()=>control.test()));
  add('PUT','/api/connections/telegram/controls',guard(body=>control.controls((body as {enabled?:unknown}|null)?.enabled)));
}
