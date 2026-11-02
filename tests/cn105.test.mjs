import test from 'node:test';
import assert from 'node:assert/strict';
import {CN105Engine,CN105_PROFILE,frameCN105,checkCN105,isCN105Request,connectCN105,queryCN105,sampleSetCN105,validateCN105Profile,validateCN105Value,displayCN105Value} from '../dist/cn105.js';
import {DiscoveryParser,DiscoverySession} from '../dist/discovery.js';
import {decodePacket,translateText,translateCapture} from '../dist/translator.js';
import {parseHex,hex,frame} from '../dist/protocol.js';
import {frameS21} from '../dist/s21.js';
const ack='FC 61 01 30 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 5E';
const payload=(code,fields={})=>{const p=Array(16).fill(0);p[0]=code;for(const [i,v] of Object.entries(fields))p[Number(i)]=v;return p;};
test('CN105 wire fixtures match upstream handshake and publicly captured SET ACK',()=>{
  const e=new CN105Engine();assert.equal(hex(connectCN105()),'FC 5A 01 30 02 CA 01 A8');
  assert.equal(hex(e.handle(connectCN105()).responses[0]),'FC 7A 01 30 01 00 54');
  assert.equal(hex(queryCN105(2)),'FC 42 01 30 10 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 7B');
  // Public Kumo write: power only, data[14]=80 is an unflagged placeholder.
  const command=parseHex('FC 41 01 30 10 01 01 00 01 00 00 00 00 00 00 00 00 00 00 80 00 FB');
  const r=e.handle(command);assert(r.accepted);assert.equal(hex(r.responses[0]),ack);assert.equal(e.value(0),1);assert.equal(e.value(3),52);
});
test('half-degree SET uses payload[14], GET settings uses payload[11], and sparse writes preserve fields',()=>{
  const e=new CN105Engine();assert(e.handle(sampleSetCN105()).accepted);
  const settings=e.handle(queryCN105(2)).responses[0].slice(5,-1);
  assert.deepEqual([settings[3],settings[4],settings[6],settings[7],settings[10],settings[11]],[1,3,5,7,12,177]);
  const before=structuredClone(e.profile);const write=frameCN105(0x41,payload(1,{1:1,3:0,4:255,6:255,14:128}));assert(e.handle(write).accepted);
  for(const s of e.services)assert.equal(s.raw,s.id===0?0:before.services.find(x=>x.id===s.id).raw);
});
test('legacy controller temperature encoding and integer profile are supported without silent rounding',()=>{
  const p=structuredClone(CN105_PROFILE);p.temperatureEncoding='legacy';const e=new CN105Engine(p);
  assert(e.handle(frameCN105(0x41,payload(1,{1:4,5:13}))).accepted);assert.equal(e.value(3),36);
  const d=e.handle(queryCN105(2)).responses[0].slice(5,-1);assert.equal(d[5],13);assert.equal(d[11],0);
  assert.equal(e.handle(sampleSetCN105()).accepted,false);assert.equal(e.value(0),0);
  p.services.find(s=>s.id===3).raw=49;assert.throws(()=>validateCN105Profile(p),/整數/);
});
test('invalid values, unknown flags, unsupported profiles, echoes and corrupted frames never change state or send ACK',()=>{
  const e=new CN105Engine(),before=structuredClone(e.profile);
  const corrupt=sampleSetCN105();corrupt[corrupt.length-1]^=1;
  const other=Array.from(connectCN105());other[3]=0x34;
  for(const b of [corrupt,other,frameCN105(0x61,Array(16).fill(0)),frameCN105(0x41,payload(1,{1:9,3:1,6:4})),frameCN105(0x41,payload(1,{1:32})),frameCN105(0x41,payload(1,{1:4,14:128})),frameCN105(0x41,payload(0x1f)),queryCN105(0x20),frameCN105(0x5b,[0xca,1]),frameCN105(0x42,payload(2,{1:1}))]){
    const r=e.handle(b);assert.equal(r.accepted,false);assert.equal(r.responses.length,0);assert.deepEqual(e.profile,before);
  }
});
test('remote temperature accepts modern and legacy encoding and disable restores local sensor',()=>{
  const e=new CN105Engine();assert(e.handle(frameCN105(0x41,payload(7,{1:1,3:173}))).accepted);
  assert.equal(e.value(31),45);assert.equal(e.handle(queryCN105(3)).responses[0][11],173);
  assert(e.handle(frameCN105(0x41,payload(7,{1:1,2:34}))).accepted);assert.equal(e.value(31),50);
  assert(e.handle(frameCN105(0x41,payload(7,{3:128}))).accepted);assert.equal(e.value(30),0);assert.equal(e.handle(queryCN105(3)).responses[0][11],182);
});
test('query response fields match the upstream controller decoder offsets and endian order',()=>{
  const e=new CN105Engine();for(const [id,v] of [[21,65526],[22,1],[23,42],[24,1234],[25,567],[26,12345],[27,4],[28,2],[29,1],[35,4],[36,12]])e.service(id).raw=v;
  const d=code=>e.handle(queryCN105(code)).responses[0].slice(5,-1);
  assert.equal(d(3)[5],118);assert.equal((d(3)[11]<<16)|(d(3)[12]<<8)|d(3)[13],12345);
  assert.deepEqual(Array.from(d(6).slice(3,9)),[42,1,4,210,2,55]);assert.deepEqual(Array.from(d(9).slice(3,6)),[2,4,1]);assert.deepEqual(Array.from(d(4).slice(4,6)),[132,12]);
  assert(e.handle(frameCN105(0x41,payload(8,{2:28,12:1,13:1,14:1}))).accepted);assert.deepEqual(Array.from(d(0x42).slice(1,4)),[1,1,1]);
});
test('profile import cannot alter field definitions and retains 65535 as data, not TaiSEIA unavailable',()=>{
  const p=structuredClone(CN105_PROFILE);p.services.find(s=>s.id===24).raw=65535;p.services.find(s=>s.id===24).name='<script>';
  const clean=validateCN105Profile(p),s=clean.services.find(s=>s.id===24);assert.equal(s.name,'輸入功率');assert.equal(displayCN105Value(s,s.raw),'65535 W');
  assert.equal(validateCN105Value(clean.services.find(s=>s.id===21),65535),null);
  assert.equal(displayCN105Value(clean.services.find(s=>s.id===21),65535),'-0.5 °C');
  p.services.push(p.services[0]);assert.throws(()=>validateCN105Profile(p));
});
test('stream parser survives every split, multiple packets, payload FC and bad checksum resynchronization',()=>{
  const command=connectCN105();for(let i=1;i<command.length;i++){const p=new DiscoveryParser();assert.equal(p.push(command.slice(0,i),0).length,0);const ev=p.push(command.slice(i),1);assert.equal(ev.length,1);assert.equal(ev[0].protocol,'cn105');assert.equal(p.protocol,'cn105');}
  const p=new DiscoveryParser();const bytes=frameCN105(0x62,payload(6,{6:252}));const events=p.push([...bytes,...command,...queryCN105(2)],0);assert.equal(events.filter(e=>e.type==='frame').length,3);
  const q=new DiscoveryParser();const bad=Array.from(command);bad[7]^=1;const out=q.push([...bad,...command],0);assert(out.some(e=>e.type==='error'));assert(out.some(e=>e.type==='frame'&&checkCN105(e.bytes)));
  const stale=new DiscoveryParser();stale.push([252,66,1,48,16,3],0);assert(stale.expire(301).some(e=>e.type==='error'));assert(stale.push(command,302).some(e=>e.type==='frame'));
});
test('responses, wrong UART dialects and short requests cannot lock discovery',()=>{
  for(const b of [frameCN105(0x7a,[0]),frameCN105(0x62,payload(2)),frameCN105(0x42,[2])]){const p=new DiscoveryParser(),s=new DiscoverySession();p.push(b);assert.equal(p.protocol,'auto');assert.equal(isCN105Request(b),false);assert.equal(s.observe('cn105',b).accepted,false);}
  for(const protocol of ['s21','taiseia']){const p=new DiscoveryParser({protocol});assert.equal(p.push(connectCN105()).filter(e=>e.type==='frame'&&e.protocol==='cn105').length,0);}
});
test('CN105 handshake requires successful 7A send followed by a valid controller command and resets on reconnect',()=>{
  const s=new DiscoverySession(),e=new CN105Engine(),c=connectCN105(),q=queryCN105(2);
  s.observe('cn105',c,0);assert.equal(s.confirmedAt,null);s.observe('cn105',q,1);assert.equal(s.confirmedAt,null);
  s.sent('cn105',c,e.handle(c).responses[0],2);assert.equal(s.stage,'identity-sent');
  assert.equal(s.observe('cn105',frameCN105(0x7a,[0]),3).accepted,false);assert.equal(s.confirmedAt,null);
  s.observe('cn105',q,4);assert.equal(s.stage,'established');assert.equal(s.deviceId,'cn105');
  s.observe('cn105',c,5);assert.equal(s.confirmedAt,null);assert.equal(s.stage,'detected');
  s.sent('cn105',c,e.handle(c).responses[0],6);s.observe('cn105',q,10007);assert.equal(s.confirmedAt,null);
  s.reset();assert.equal(s.protocol,null);assert.equal(s.identitySent,false);
});
test('CN105 translator decodes public captures, flagged SET, corrupt packets and mixed protocols',()=>{
  const publicSettings=parseHex('FC 62 01 30 10 02 00 00 01 01 0D 00 00 00 00 83 A4 46 00 00 00 DF');
  const p=decodePacket(publicSettings);assert(p.checksum.valid);assert(p.fields.some(f=>f.label==='設定溫度'&&f.value==='18 °C'));assert(p.fields.some(f=>f.label==='左右風向'&&f.value==='中'));
  const command=decodePacket(sampleSetCN105());assert.match(command.summary,/24.5 °C/);assert.match(command.summary,/擺動/);
  const invalid=Array.from(sampleSetCN105());invalid[21]^=1;assert.equal(decodePacket(invalid).status,'error');
  const mixed=translateText([hex(frame(1,0,65535)),hex(connectCN105()),hex(queryCN105(2)),hex(frameS21('F1'))].join('\n'));
  assert.deepEqual(mixed.packets.map(p=>p.protocol),['taiseia','cn105','cn105','s21']);
  const text=translateText('RX: FC 5A 01\n30 02 CA 01 A8\nTX: FC 7A 01 30 01 00 54');assert.equal(text.packets.length,2);assert(text.packets.every(p=>p.checksum.valid));
  const recovered=translateText(hex(invalid)+' '+hex(connectCN105()),{protocol:'cn105'});assert(recovered.packets.some(p=>p.checksum?.valid));
  const c=translateCapture({profiles:{1:CN105_PROFILE},records:[{kind:'frame',direction:'TX',protocol:'cn105',profileRevision:1,bytes:Array.from(publicSettings)}]});assert.equal(c.warnings.length,0);assert.equal(c.packets[0].protocol,'cn105');
  assert.match(decodePacket(connectCN105(),{direction:'TX'}).warnings.join(' '),/方向/);
});
