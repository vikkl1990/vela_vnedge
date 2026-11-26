import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {SubscriptionScope} from './subscriptions.ts';

test('shutdown detaches owned subscriptions without deleting injected or later operator listeners',()=>{
  const emitter=new EventEmitter(),scope=new SubscriptionScope();let external=0,owned=0,later=0;
  emitter.on('tick',()=>external++);scope.watch(emitter);
  emitter.on('tick',()=>owned++);emitter.once('other',()=>owned++);scope.seal();
  emitter.on('tick',()=>later++);scope.detach();scope.detach();
  emitter.emit('tick');emitter.emit('other');
  assert.equal(external,1);assert.equal(later,1);assert.equal(owned,0);
});
