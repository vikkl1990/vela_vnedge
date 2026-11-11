import {test} from 'node:test'
import assert from 'node:assert/strict'
import {heatValue,heatLabel,evidenceBook} from '../src/lib/monitorHeatmap.ts'
import type {MonitorPair} from '../src/api/tradeMonitor.ts'
const pair={paper:{trades:0,r:0},shadow:{trades:2,r:-1.1},worstOpenR:null,change24hPct:2.2,flow:{covered:false,imbalance:.8}} as MonitorPair
test('no trades and incomplete flow stay unknown rather than a neutral or profitable tile',()=>{assert.equal(heatValue(pair,'paper'),null);assert.equal(heatValue(pair,'flow'),null);assert.equal(heatValue(pair,'shadow'),-1.1);assert.equal(heatValue(pair,'open'),null)})
test('R, market returns and buy/sell imbalance retain distinct units',()=>{assert.equal(heatLabel(.2,'flow'),'+20%');assert.equal(heatLabel(.2,'paper'),'+0.20R');assert.equal(heatLabel(null,'open'),'No data');assert.equal(heatLabel(NaN,'open'),'No data')})
test('research outcomes cannot be presented as regular shadow or paper',()=>{assert.equal(evidenceBook(0,'paper'),'Paper');assert.equal(evidenceBook(2,'shadow'),'Shadow');assert.equal(evidenceBook(2,'tracker'),'Research');assert.equal(evidenceBook(2,'experiment'),'Research')})
