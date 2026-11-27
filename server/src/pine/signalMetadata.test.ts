import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {signalSymbolInfo,signalMetadataText} from '../../../shared/signalMetadata.ts';
import {DeltaPineProvider} from './provider.ts';

test('shared signal metadata exactly preserves the deployed server profile across contract sizes and timezones',async()=>{
 const baseline=JSON.parse(fs.readFileSync(new URL('./signalMetadata.baseline.json',import.meta.url),'utf8'));
 for(const b of baseline){
  const provider=new DeltaPineProvider({...b,tf:'15m',bars:[]});
  const info=await provider.getSymbolInfo(b.symbol);
  assert.equal(createHash('sha256').update(signalMetadataText(info)).digest('hex'),b.hash,b.symbol);
  assert.deepEqual(info,signalSymbolInfo(b.symbol,b.tickSize,b.timezone));
  assert.equal(info.pointvalue,1);assert.equal(info.mincontract,.000001);
 }
 assert.equal(signalMetadataText(signalSymbolInfo('BTCUSD',.5,'UTC')),signalMetadataText(signalSymbolInfo('BTCUSD',.5,'Etc/UTC')));
 assert.notEqual(signalMetadataText(signalSymbolInfo('BTCUSD',.5)),signalMetadataText({...signalSymbolInfo('BTCUSD',.5),pointvalue:.001}));
});
