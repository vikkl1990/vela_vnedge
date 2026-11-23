import { test } from 'node:test';
import assert from 'node:assert/strict';
import {ApiServer} from './server.ts';


test('the static handler serves only files inside the dist directory, not a sibling with the same prefix', async () => {
  const { insideDir } = await import('./server.ts');
  const path = await import('node:path');
  const dist = path.join('/opt', 'vnedge', 'dashboard', 'dist');
  assert.equal(insideDir(path.join(dist, 'index.html'), dist), true);
  assert.equal(insideDir(dist, dist), true);
  assert.equal(insideDir(path.join('/opt', 'vnedge', 'dashboard', 'dist-backup', 'x'), dist), false);
  assert.equal(insideDir(path.join('/opt', 'vnedge', 'dashboard', 'dist_secret'), dist), false);
});

test('idle SSE never builds snapshots; connected viewers share one current snapshot', () => {
  // Exercise the real broadcast path without opening a listener or an authenticated session.
  const server=Object.create(ApiServer.prototype) as ApiServer;
  const viewers=new Set<{write:(payload:string)=>void}>();
  Object.assign(server,{sse:viewers});
  let builds=0,version=1;
  const snapshot=()=>{builds++;return {version};};
  server.broadcastLazy('stats',snapshot);assert.equal(builds,0);
  const first:string[]=[],second:string[]=[];
  const a={write:(payload:string)=>{first.push(payload);}},b={write:(payload:string)=>{second.push(payload);}};
  viewers.add(a);viewers.add(b);server.broadcastLazy('stats',snapshot);
  assert.equal(builds,1);assert.deepEqual(first,second);assert.match(first[0],/"version":1/);
  version=2;viewers.delete(b);server.broadcastLazy('stats',snapshot);
  assert.equal(builds,2);assert.match(first[1],/"version":2/);assert.equal(second.length,1);
  viewers.clear();server.broadcastLazy('health',()=>{throw Error('idle health must not run');});
});
