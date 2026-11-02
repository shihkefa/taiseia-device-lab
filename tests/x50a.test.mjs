import test from 'node:test';
import assert from 'node:assert/strict';
import {X50AEngine,X50A_PROFILE,frameX50A,checkX50A,isX50ARequest,connectX50A,queryX50A,sampleSetX50A,sampleFanX50A,validateX50AProfile,inspectX50A} from '../dist/x50a.js';
import {DiscoveryParser,DiscoverySession,SERIAL_PRESETS} from '../dist/discovery.js';
import {frame,hex} from '../dist/protocol.js';
import {frameS21} from '../dist/s21.js';
import {connectCN105} from '../dist/cn105.js';
import {decodePacket,translateText,translateCapture} from '../dist/translator.js';
const bytes=text=>Uint8Array.from(text.split(/\s+/).map(n=>parseInt(n,16)));
// Literal wire fixtures, independently summed; synthetic, not hardware captures.
const AA=bytes('06 AA 07 01 00 01 46'),READY=bytes('06 AA 07 01 06 01 40');
const SET=bytes('06 CA 17 01 00 03 12 00 18 85 00 00 00 00 00 00 00 00 00 00 00 00 65');
const FAN=bytes('06 CB 08 01 00 02 BF 64');
const value=(p,label)=>p.fields.find(f=>f.label===label)?.value;

test('X50A literal request and reply use sum FF, role and byte-2 length',()=>{
  assert.deepEqual(connectX50A(),AA);assert.deepEqual(sampleSetX50A(),SET);assert.deepEqual(sampleFanX50A(),FAN);
  for(const b of [AA,READY,SET,FAN]){assert.equal(checkX50A(b),true);assert.equal(Array.from(b).reduce((a,n)=>a+n,0)&255,255);}
  assert.equal(isX50ARequest(READY),false);assert.equal(isX50ARequest(AA),true);
  assert.deepEqual(SERIAL_PRESETS.x50a,{baudRate:9600,dataBits:8,parity:'even',stopBits:1});
  assert.equal(SERIAL_PRESETS['x50a-e2'].stopBits,2);
});
test('initialization returns ready and a declared simulator model, not an invented detected model',()=>{
  const e=new X50AEngine();assert.deepEqual(e.handle(AA).responses[0],READY);
  const reply=e.handle(bytes('06 BA 06 01 00 38')).responses[0];
  assert.equal(reply.length,35);assert.equal(reply[4],6);assert.equal(value(decodePacket(reply,{direction:'TX'}),'設備宣告型號'),'SIM-X50A');
});
test('power, mode, tenths, fan and swing writes are reflected in CA, BD and BE readback',()=>{
  const e=new X50AEngine();assert.equal(e.handle(SET).accepted,true);assert.equal(e.handle(FAN).accepted,true);
  assert.deepEqual([0,1,2,3,4].map(id=>e.value(id)),[1,2,3,245,7]);
  const ca=e.handle(queryX50A(0xca)).responses[0],bd=e.handle(queryX50A(0xbd)).responses[0],be=e.handle(queryX50A(0xbe)).responses[0];
  assert.equal(ca[5],1);assert.equal(ca[6],2);assert.equal(ca[8],24);assert.equal(ca[9],5);assert.equal(ca[11],0x31);
  assert.deepEqual(Array.from(bd.slice(13,15)),[0x40,0x0c]);assert.deepEqual(Array.from(be.slice(7,11)),[0x84,3,7,1]);
});
test('query placeholders and partial flags preserve all unselected settings, including auto fan and stopped vane',()=>{
  const e=new X50AEngine();e.handle(SET);e.handle(FAN);
  const previous=structuredClone(e.profile);for(const cmd of [0xca,0xcb])assert.equal(e.handle(queryX50A(cmd)).accepted,true);
  assert.deepEqual(e.profile,previous);
  e.handle(frameX50A(0xcb,[0,0x80]));assert.equal(e.value(2),0);assert.equal(e.value(4),7);
  e.handle(frameX50A(0xcb,[0,0x08]));assert.equal(e.value(4),0);assert.equal(e.value(0),1);
  const off=Array(17).fill(0);off[0]=2;e.handle(frameX50A(0xca,off));assert.equal(e.value(0),0);assert.equal(e.value(3),245);
});
for(const mode of [0,1,2,3,7])test('CA mode '+mode+' uses X50A namespace rather than S21 codes',()=>{
  const e=new X50AEngine(),d=Array(17).fill(0);d[1]=0x10|mode;assert.equal(e.handle(frameX50A(0xca,d)).accepted,true);assert.equal(e.value(1),mode);
  assert.equal(e.handle(queryX50A(0xca)).responses[0][6],mode);
});
test('invalid combined writes reject atomically, even when their frame checksum is correct',()=>{
  const e=new X50AEngine(),before=structuredClone(e.profile);
  const cases=[];let d=Array(17).fill(0);d[0]=3;d[1]=0x14;cases.push(frameX50A(0xca,d));
  d=Array(17).fill(0);d[0]=3;d[3]=24;d[4]=0x8a;cases.push(frameX50A(0xca,d));
  d=Array(17).fill(0);d[0]=3;d[10]=1;cases.push(frameX50A(0xca,d));
  cases.push(frameX50A(0xcb,[1,0xe0]),frameX50A(0xcb,[1,0x0d]),frameX50A(0xcb,[1,0x30]),frameX50A(0xcb,[1,7]));
  for(const b of cases){assert.equal(checkX50A(b),true);const r=e.handle(b);assert.equal(r.accepted,false);assert.equal(r.responses.length,0);assert.deepEqual(e.profile,before);}
});
test('unknown commands, response echoes, malformed lengths and corrupt checksum never mutate the device',()=>{
  const e=new X50AEngine(),before=structuredClone(e.profile),corrupt=Uint8Array.from(SET);corrupt[corrupt.length-1]^=1;
  for(const b of [corrupt,READY,frameX50A(0xfe),frameX50A(0xca,[3]),frameX50A(0xcb,[1]),frameX50A(0xaa,[0])]){assert.equal(e.handle(b).accepted,false);assert.deepEqual(e.profile,before);}
});
test('BD and B7 encode signed little-endian Q7 temperatures and outdoor frequency in its own field',()=>{
  const e=new X50AEngine();e.service(20).raw=(-55)&65535;e.service(23).raw=(-100)&65535;e.service(25).raw=437;
  const bd=e.handle(queryX50A(0xbd)).responses[0],b7=e.handle(queryX50A(0xb7)).responses[0];
  assert.deepEqual(Array.from(bd.slice(5,7)),[0x40,0xfd]);assert.deepEqual(Array.from(b7.slice(5,7)),[0,0xfb]);assert.deepEqual(Array.from(b7.slice(31,33)),[0xb5,1]);
  assert.match(value(decodePacket(bd),'進風溫度'),/^-5.5 °C/);assert.match(value(decodePacket(b7),'壓縮機頻率'),/^43.7 Hz/);
});
test('B7 unsupported response is explicit and cannot act as normal status or a request',()=>{
  const p=structuredClone(X50A_PROFILE);p.outdoorReply='unsupported';const b=new X50AEngine(p).handle(queryX50A(0xb7)).responses[0];
  assert.equal(b[4],18);assert.equal(isX50ARequest(b),false);const decoded=decodePacket(b);assert.equal(decoded.status,'warning');assert.match(decoded.warnings.join(' '),/不能.*控制成功/);
});
test('not-ready simulation does not return successful state replies after initialization',()=>{
  const p=structuredClone(X50A_PROFILE);p.services.find(s=>s.id===7).raw=0;const e=new X50AEngine(p);
  assert.equal(e.handle(AA).responses[0][5],0);assert.equal(e.handle(queryX50A(0xca)).accepted,false);
});
test('profile import validates fixed schema, values, safe model and independent cloning',()=>{
  const p=structuredClone(X50A_PROFILE),clean=validateX50AProfile(p);p.services[0].raw=1;assert.equal(clean.services[0].raw,0);
  for(const mutate of [x=>x.model='<script>',x=>x.replyDelay=-1,x=>x.outdoorReply='unknown',x=>x.services[0].raw=2,x=>x.services.push(x.services[0]),x=>x.services[0].id=999]){
    const bad=structuredClone(X50A_PROFILE);mutate(bad);assert.throws(()=>validateX50AProfile(bad));
  }
});
test('fragmented AA is recognized only when complete; concatenated requests each survive',()=>{
  for(let split=1;split<AA.length;split++){const p=new DiscoveryParser();const first=p.push(AA.slice(0,split),0);assert.equal(first.filter(e=>e.type==='frame').length,0);assert.equal(p.protocol,'auto');const next=p.push([...AA.slice(split),...queryX50A(0xba)],10);assert.equal(next.filter(e=>e.type==='frame').length,2);assert.equal(p.protocol,'x50a');}
});
test('X50A responses and checksum-valid unknown commands cannot lock automatic discovery',()=>{
  for(const b of [READY,frameX50A(0xfe)]){const p=new DiscoveryParser();p.push(b,0);assert.equal(p.protocol,'auto');assert.equal(new DiscoverySession().observe('x50a',b).accepted,false);}
});
test('X50A rejects corrupt frames and recovers a subsequent command without needing a new connection',()=>{
  const corrupt=Uint8Array.from(SET);corrupt[corrupt.length-1]^=1;const p=new DiscoveryParser();
  const ev=p.push([255,127,...corrupt,...AA],0);assert.deepEqual(ev.filter(e=>e.type==='frame').map(e=>Array.from(e.bytes)),[Array.from(AA)]);assert.equal(p.protocol,'x50a');
});
test('stray S21 STX before X50A does not hide a complete initialization request',()=>{
  const p=new DiscoveryParser(),events=p.push([2,127,...AA],0);assert.deepEqual(events.filter(e=>e.type==='frame').map(e=>Array.from(e.bytes)),[Array.from(AA)]);assert.equal(p.protocol,'x50a');
});
test('an expired incomplete X50A prefix does not hide a later valid request',()=>{
  const p=new DiscoveryParser();const events=[...p.push([6,0xaa,250,1,0,...AA],0),...p.expire(301)];assert.equal(events.filter(e=>e.type==='frame').length,1);assert.equal(p.protocol,'x50a');
});
test('X50A handshake requires sent ready response and a subsequent successfully replied command',()=>{
  const s=new DiscoverySession(),e=new X50AEngine(),a=connectX50A(),query=queryX50A(0xba);
  s.observe('x50a',a,0);assert.notEqual(s.stage,'established');s.sent('x50a',a,e.handle(a).responses[0],1);assert.equal(s.stage,'identity-sent');
  s.observe('x50a',query,2);assert.equal(s.stage,'identity-sent');s.sent('x50a',query,e.handle(query).responses[0],3);assert.equal(s.stage,'established');
  const unknown=frameX50A(0xfe);assert.equal(s.observe('x50a',unknown,4).accepted,false);
  const reset=connectX50A();s.observe('x50a',reset,5);assert.equal(s.confirmedAt,null);
});
test('a reply to an unobserved or expired query cannot establish X50A handshake',()=>{
  const s=new DiscoverySession(),e=new X50AEngine(),a=connectX50A(),q=queryX50A(0xba);
  s.observe('x50a',a,0);s.sent('x50a',a,READY,1);s.sent('x50a',q,e.handle(q).responses[0],2);assert.notEqual(s.stage,'established');
  s.observe('x50a',q,10002);s.sent('x50a',q,e.handle(q).responses[0],10003);assert.notEqual(s.stage,'established');
});
test('other protocol requests retain their family and checksum after adding X50A',()=>{
  for(const [protocol,b] of [['taiseia',frame(0,0,65535)],['s21',frameS21('F1')],['cn105',connectCN105()]]){
    const p=new DiscoveryParser();assert.equal(p.push(b,0).find(e=>e.type==='frame').protocol,protocol);assert.equal(p.protocol,protocol);assert.equal(new DiscoverySession({protocol}).observe('x50a',AA).accepted,false);
  }
});
test('all X50A query and write families translate both roles, preserving bytes and correct fixed values',()=>{
  const e=new X50AEngine(),records=[];let id=0;
  for(const b of [AA,queryX50A(0xba),queryX50A(0xbb),SET,FAN,queryX50A(0xca),queryX50A(0xcb),queryX50A(0xbd),queryX50A(0xbe),queryX50A(0xb7)]){
    const response=e.handle(b).responses[0];for(const [direction,packet] of [['RX',b],['TX',response]]){const p=decodePacket(packet,{direction});assert.equal(p.protocol,'x50a');assert.equal(p.checksum.valid,true);assert.deepEqual(p.bytes,Array.from(packet));assert.doesNotMatch(p.summary,/undefined|NaN/);records.push({id:++id,kind:'frame',protocol:'x50a',direction,bytes:Array.from(packet)});}
  }
  const out=translateText(records.map(r=>r.direction+': '+hex(r.bytes)).join('\n'));assert.equal(out.packets.length,20);assert.ok(out.packets.every(p=>p.protocol==='x50a'));
  assert.match(value(out.packets[7],'設定溫度'),/^24.5 °C/);assert.equal(value(out.packets[17],'上下風向'),'擺動');
  const imported=translateCapture({records,profiles:{}});assert.equal(imported.packets.length,20);assert.ok(imported.packets.every(p=>p.checksum.valid));
});
test('X50A translator warns for role mismatch, unknown data, invalid values and checksum without repairing them',()=>{
  assert.match(decodePacket(READY,{direction:'RX'}).warnings.join(' '),/方向/);
  assert.equal(decodePacket(frameX50A(0xfa,[],6)).status,'warning');
  assert.match(inspectX50A(frameX50A(0xca,[1],6)).warnings.join(' '),/需要 17/);
  const corrupt=Array.from(READY);corrupt[6]^=1;const p=decodePacket(corrupt);assert.equal(p.checksum.valid,false);assert.deepEqual(p.bytes,corrupt);
});
test('mixed protocol translation stays synchronized after X50A, TaiSEIA, S21 and CN105 frames',()=>{
  const wires=[AA,frame(1,3,26),frameS21('F1'),connectCN105()];
  assert.deepEqual(translateText(hex(wires.flatMap(b=>Array.from(b)))).packets.map(p=>p.protocol),['x50a','taiseia','s21','cn105']);
});
