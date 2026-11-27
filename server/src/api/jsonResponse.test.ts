import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {json} from './server.ts';

test('large report compression is asynchronous and preserves the JSON response',async t=>{
 const body={text:'évidence '.repeat(10000),missing:Infinity},states:boolean[]=[];
 const server=http.createServer((req,res)=>{json(res,200,body,req);states.push(res.headersSent);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const address=server.address();assert.ok(address&&typeof address==='object');const port=address.port;
 async function request(gzip:boolean){return new Promise<{headers:http.IncomingHttpHeaders;body:Buffer}>((resolve,reject)=>{
  http.get({host:'127.0.0.1',port,agent:false,headers:gzip?{'accept-encoding':'gzip'}:{}},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);
  }).on('error',reject);
 });}
 const compressed=await request(true);assert.equal(states[0],false,'compression must leave the event loop before sending');
 assert.equal(compressed.headers['content-encoding'],'gzip');assert.equal(compressed.headers.vary,'Accept-Encoding');
 assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed.body).toString()),{text:body.text,missing:null});
 const plain=await request(false);assert.equal(states[1],true);assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.body.toString(),zlib.gunzipSync(compressed.body).toString());
});
