import {ConnectionError} from '../connections/delta.ts';

export type TelegramMethod='getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'setMyCommands';
export type TelegramCall=<T>(method:TelegramMethod,body?:Record<string,unknown>,signal?:AbortSignal)=>Promise<T>;

/** Fixed Telegram host; never expose upstream error text, request URLs or tokens. */
export function telegramClient(token:string,fetchImpl:typeof fetch=fetch):TelegramCall {
  return async <T>(method:TelegramMethod,body:Record<string,unknown>={},signal?:AbortSignal):Promise<T>=>{
    try {
      const response=await fetchImpl(`https://api.telegram.org/bot${token}/${method}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
        signal:AbortSignal.any([AbortSignal.timeout(method==='getUpdates'?30000:10000),...(signal?[signal]:[])]),
      });
      const data=await response.json() as {ok?:boolean;result?:T;error_code?:number};
      if(!response.ok||data.ok!==true){
        const code=data.error_code??response.status;
        throw new ConnectionError(code===429?429:502,code===401?'Telegram rejected the bot token.':code===403?'Telegram cannot message this chat. Open the bot and press Start.':code===409?'Telegram updates are in use by another receiver or webhook. Use a dedicated bot.':code===429?'Telegram rate limit reached. Try again shortly.':'Telegram request failed. Try again shortly.');
      }
      return data.result as T;
    } catch(e) {
      if(e instanceof ConnectionError)throw e;
      throw new ConnectionError(502,signal?.aborted?'Telegram request stopped.':'Telegram is unavailable or the request timed out.');
    }
  };
}

export function validBotToken(value:unknown):string {
  if(typeof value!=='string'||!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(value.trim()))
    throw new ConnectionError(400,'Enter the bot token supplied by BotFather.');
  return value.trim();
}
