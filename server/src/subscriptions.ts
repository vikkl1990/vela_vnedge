import type {EventEmitter} from 'node:events';

/** Preserve injected collaborators' listeners; detach only this composition's constructor wiring. */
export class SubscriptionScope {
  private watched:Array<{emitter:EventEmitter;before:Map<string|symbol,Function[]>}>=[];
  private owned:Array<{emitter:EventEmitter;event:string|symbol;listener:Function}>=[];
  watch(emitter:EventEmitter){
    this.watched.push({emitter,before:new Map(emitter.eventNames().map(event=>[event,emitter.rawListeners(event)]))});
  }
  seal(){
    for(const {emitter,before} of this.watched)for(const event of emitter.eventNames()){
      const counts=new Map<Function,number>();
      for(const fn of before.get(event)??[])counts.set(fn,(counts.get(fn)??0)+1);
      for(const listener of emitter.rawListeners(event)){
        const n=counts.get(listener)??0;
        if(n)counts.set(listener,n-1);else this.owned.push({emitter,event,listener});
      }
    }
    this.watched=[];
  }
  detach(){for(const {emitter,event,listener} of this.owned.splice(0))emitter.off(event,listener as (...args:unknown[])=>void);}
}
