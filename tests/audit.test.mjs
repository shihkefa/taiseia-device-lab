import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILES} from '../dist/catalog.js';
import {DeviceEngine,frame,checkFrame,validateValue,validateProfile,hex} from '../dist/protocol.js';
import {DiscoveryParser} from '../dist/discovery.js';
import {connectCN105,frameCN105} from '../dist/cn105.js';
import {frameS21} from '../dist/s21.js';
import {decodePacket} from '../dist/translator.js';
import {Capture} from '../dist/capture.js';

for(const base of PROFILES)test(`${base.name}: every supported field reads back at valid extrema and enumerated values`,()=>{
  const engine=new DeviceEngine(base);
  for(const s of engine.profile.services){
    s.enabled=true;
    for(const value of [...new Set([s.raw,s.min&65535,s.max&65535,...Object.keys(s.enum||{}).map(Number)])]){
      if(validateValue(s,value))continue;
      if(s.writable)assert.equal(engine.handle(frame(base.saId,s.id|128,value)).accepted,true,`${s.name} write ${value}`);
      else s.raw=value;
      const r=engine.handle(frame(base.saId,s.id,65535));assert(r.accepted);assert(checkFrame(r.response));assert.equal((r.response[3]<<8)|r.response[4],s.raw,`${s.name} readback`);
    }
    s.enabled=false;assert.equal(engine.handle(frame(base.saId,s.id,65535)).accepted,false,'disabled service must be rejected');
  }
});
for(const [protocol,valid] of [['cn105',connectCN105()],['s21',frameS21('F1')],['taiseia',frame(0,0,65535)]])test(`${protocol}: recover from every possible single noise byte before a complete command`,()=>{
  for(let noise=0;noise<256;noise++){
    const p=new DiscoveryParser();const events=[...p.push([noise,...valid],0),...p.expire(301)];
    assert(events.some(e=>e.type==='frame'&&hex(e.bytes)===hex(valid)),`noise ${noise.toString(16)}`);
  }
});
test('valid CN105 checksum cannot hide undefined enum or temperature values',()=>{
  const payload=Array(16).fill(0);payload[0]=2;payload[3]=9;payload[4]=255;payload[5]=255;
  const p=decodePacket(frameCN105(0x62,payload));assert(p.checksum.valid);assert.equal(p.status,'warning');assert(p.warnings.some(s=>s.includes('電源')));assert(p.warnings.some(s=>s.includes('設定溫度')));
});
test('TaiSEIA import rejects unsupported protocol identifiers before changing app selection',()=>{
  const p=structuredClone(PROFILES[0]);for(const protocol of ['invalid',null,{},'cn105']){p.protocol=protocol;assert.throws(()=>validateProfile(p),/protocol/);}
  p.protocol='taiseia';assert.doesNotThrow(()=>validateProfile(p));delete p.protocol;assert.doesNotThrow(()=>validateProfile(p));
});
test('capture keeps ordered duplicate packets, evicts old records, escapes CSV text and resets counters',()=>{
  const c=new Capture(3);const bytes=frame(1,0,65535);c.add({direction:'RX',kind:'frame',bytes,description:'冷房,"quoted"\nnext'});c.add({direction:'RX',kind:'frame',bytes});
  c.add({direction:'SYS',kind:'event',error:true});const last=c.add({direction:'TX',kind:'frame',bytes});assert.equal(c.records.length,3);assert.equal(c.dropped,1);assert.deepEqual(c.counts,{RX:2,TX:1,error:1});assert.equal(c.records[0].id,2);assert.equal(last.id,4);
  const csv=new Capture();csv.add({description:'冷房,"quoted"\nnext',bytes});assert.match(csv.csv(),/"冷房,""quoted""\nnext"/);assert(csv.csv().startsWith('\uFEFF'));
  c.clear();assert.equal(c.records.length,0);assert.equal(c.dropped,0);assert.deepEqual(c.counts,{RX:0,TX:0,error:0});assert.equal(c.add({}).id,5,'ids do not collide after clearing');
});
