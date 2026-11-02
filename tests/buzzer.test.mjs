import test from 'node:test';
import assert from 'node:assert/strict';
import {getBuzzerStatus} from '../dist/buzzer.js';
import {PROFILES} from '../dist/catalog.js';
import {S21_PROFILE} from '../dist/s21.js';
import {CN105_PROFILE} from '../dist/cn105.js';
import {X50A_PROFILE} from '../dist/x50a.js';
for(const [sa,id] of [[1,30],[4,24]])test('TaiSEIA '+sa+' beeper uses inverted 0=on / 1=off without confusing unavailable state',()=>{
  const p=structuredClone(PROFILES.find(p=>p.saId===sa)),s=p.services.find(s=>s.id===id);
  for(const [raw,state,text] of [[0,'on','開啟'],[1,'off','關閉'],[65535,'unknown','未知（FFFF）'],[7,'unknown','未知值 7']]){s.raw=raw;assert.deepEqual(getBuzzerStatus(p),{id,state,text});}
  s.enabled=false;assert.deepEqual(getBuzzerStatus(p),{id,state:'unavailable',text:'未提供'});
});
test('unmapped devices do not invent a buzzer, even when an imported field has the same name or ID',()=>{
  for(const base of [...PROFILES.filter(p=>![1,4].includes(p.saId)),S21_PROFILE,CN105_PROFILE,X50A_PROFILE]){
    const p=structuredClone(base);p.services.push({id:30,name:'蜂鳴器',raw:0,enabled:true});assert.equal(getBuzzerStatus(p),null);
  }
  assert.equal(getBuzzerStatus({...PROFILES[0],protocol:'x50a'}),null);assert.equal(getBuzzerStatus(null),null);
});
