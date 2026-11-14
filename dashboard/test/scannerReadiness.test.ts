import {test} from 'node:test'
import assert from 'node:assert/strict'
import {filterReadiness,ROLE_LABELS} from '../src/lib/scannerReadiness.ts'
import type {ReadinessRow} from '../../shared/scannerContracts.ts'
const base={key:'base',scannerId:'base',name:'Scanner',author:'Willy',enabled:true,planId:null,runtime:'collecting',contract:{gaps:[]},cells:[{symbol:'ETHUSD',book:'paper'}]} as ReadinessRow
const research={...base,key:'plan:test',planId:'test',enabled:false,cells:[{symbol:'SOLUSD',book:'research'}]} as ReadinessRow
test('matrix filters keep experiments separate from paper and allow pair searches',()=>{
 assert.deepEqual(filterReadiness([base,research],'','paper'),[base])
 assert.deepEqual(filterReadiness([base,research],'','research'),[research])
 assert.deepEqual(filterReadiness([base,research],' solusd ','all'),[research])
 assert.deepEqual(filterReadiness([base,research],'','held'),[])
 assert.equal(ROLE_LABELS.context,'Context indicator')
 assert.equal(ROLE_LABELS.unresolved,'Unresolved')
})
