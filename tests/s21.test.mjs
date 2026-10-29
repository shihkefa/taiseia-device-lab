import test from 'node:test';
import assert from 'node:assert/strict';
import {ACK,S21_PROFILE,S21Engine,ascii,checksumS21,frameS21,checkS21,commandS21,validateS21Profile,validateS21Value,displayS21Value} from '../dist/s21.js';
import {hex,parseHex} from '../dist/protocol.js';

// Independently calculated vectors using the public asund / RevK mappings,
// not a claim that these bytes were captured from hardware. See docs/s21.md.
const F1=parseHex('02 46 31 77 03');
const D1=parseHex('02 44 31 31 33 4E 41 68 03'); // on, cool, 25 C, auto fan

test('automatic mode variants 0, 1 and 7 preserve their wire values on readback',()=>{
  for(const mode of [48,49,55]){const e=new S21Engine();assert.equal(e.handle(frameS21('D1',[49,mode,76,65])).accepted,true);assert.equal(e.handle(frameS21('F1')).responses[1][4],mode);}
});
const G1=parseHex('02 47 31 31 33 4E 41 6B 03');
const cloneProfile=()=>structuredClone(S21_PROFILE);
const setRaw=(profile,id,raw)=>{profile.services.find(s=>s.id===id).raw=raw;};
const replies=result=>result.responses.map(hex);
const data=result=>Array.from(result.responses[1].slice(3,-2));

test('S21 F1 and D1 vectors have checksum over command and payload only',()=>{
  assert.deepEqual(frameS21('F1'),F1);
  assert.deepEqual(frameS21('D1',[0x31,0x33,0x4e,0x41]),D1);
  assert(checkS21(F1));assert(checkS21(D1));assert(checkS21(G1));
  assert.equal(commandS21(F1),'F1');
  assert.equal(commandS21(frameS21('Ra')),'Ra');
});

test('all four reserved checksum sums are replaced by sum plus two',()=>{
  for(const [last,wire] of [[0x8b,0x04],[0x8c,0x05],[0x8f,0x08],[0x9e,0x17]]){
    const body=[0x46,0x31,last];
    assert.equal(checksumS21(body),wire);
    const packet=Uint8Array.from([0x02,...body,wire,0x03]);
    assert.deepEqual(frameS21('F1',[last]),packet);
    assert(checkS21(packet));
    packet[packet.length-2]=wire-2;
    assert.equal(checkS21(packet),false);
  }
  assert.equal(checksumS21([0xff,0xff]),0xfe);
});

test('binary payload bytes are preserved and invalid frame checks fail closed',()=>{
  const binary=frameS21('G2',[0x00,0x80,0xfe,0xff]);
  assert.deepEqual(Array.from(binary.slice(3,-2)),[0x00,0x80,0xfe,0xff]);
  assert(checkS21(binary));
  for(const b of [[],[ACK],F1.slice(1),F1.slice(0,-1),[...F1,0],parseHex('02 46 31 76 03')])assert.equal(checkS21(b),false);
  for(const bad of [-1,256,1.5,NaN,Infinity])assert.throws(()=>frameS21('F1',[bad]));
  for(const cmd of ['', 'F\n','é1','1234567'])assert.throws(()=>frameS21(cmd));
});

test('one-character and six-character requests are framed but unsupported v2 requests NAK',()=>{
  const e=new S21Engine();
  for(const [cmd,wire] of [['M','02 4D 4D 03'],['V','02 56 56 03'],['VS000M','02 56 53 30 30 30 4D 86 03']]){
    const b=parseHex(wire);
    assert.deepEqual(frameS21(cmd),b);
    assert(checkS21(b));assert.equal(commandS21(b),cmd);
    const r=e.handle(b);assert.equal(r.accepted,false);assert.deepEqual(replies(r),['15']);
  }
});

test('query emits ACK before reply; D1 emits only ACK and readback reflects all fields',()=>{
  const e=new S21Engine();
  const written=e.handle(D1);
  assert.equal(written.accepted,true);assert.deepEqual(replies(written),['06']);
  assert.deepEqual([e.value(0),e.value(1),e.value(3),e.value(2)],[1,3,50,65]);
  assert.equal(written.changes.length,4);
  const queried=e.handle(F1);
  assert.equal(queried.accepted,true);assert.deepEqual(queried.responses,[Uint8Array.of(ACK),G1]);
});

test('D1 validates the complete command before changing any state',()=>{
  for(const invalid of [
    [0x31,0x35,0x4e,0x41], // unsupported mode, after a valid changed power
    [0x31,0x33,0x4e,0x38], // unsupported fan, after three otherwise valid fields
    [0x31,0x33,0x1c,0x41], // target outside configured range
    [0x32,0x33,0x4e,0x41], // invalid power
    [0x31,0x33,0x4e],
    [0x31,0x33,0x4e,0x41,0x30]
  ]){
    const e=new S21Engine(),before=structuredClone(e.services);
    const r=e.handle(frameS21('D1',invalid));
    assert.equal(r.accepted,false);assert.deepEqual(replies(r),['15']);
    assert.deepEqual(e.services,before);
  }
});

test('bad checksum is silently dropped without ACK or mutation',()=>{
  const e=new S21Engine(),before=structuredClone(e.services),broken=D1.slice();
  broken[broken.length-2]^=1;
  const r=e.handle(broken);
  assert.equal(r.accepted,false);assert.deepEqual(r.responses,[]);
  assert.deepEqual(e.services,before);
});

test('v2 version F8 replies; unknown F/R/D and v3 FY00 are explicit NAKs',()=>{
  const e=new S21Engine();
  const version=e.handle(parseHex('02 46 38 7E 03'));
  assert.equal(version.accepted,true);
  assert.equal(hex(version.responses[0]),'06');
  assert(checkS21(version.responses[1]));
  assert.deepEqual(data(version).slice(0,2),ascii('02'));
  for(const b of [parseHex('02 46 59 30 30 FF 03'),frameS21('FZ'),frameS21('RZ'),frameS21('D9','0000'),frameS21('F1','0000')]){
    const r=e.handle(b);assert.equal(r.accepted,false);assert.deepEqual(replies(r),['15']);
  }
  // Receiving a response is not a new controller query and must not cause a loop.
  assert.deepEqual(e.handle(G1).responses,[]);
});

test('sensor temperatures are reversed decimal tenths with a trailing sign',()=>{
  const p=cloneProfile();setRaw(p,20,230);setRaw(p,21,(-185)&65535);setRaw(p,22,(-5)&65535);
  const e=new S21Engine(p);
  assert.deepEqual(replies(e.handle(frameS21('RH'))),['06','02 53 48 30 33 32 2B 5B 03']);
  assert.deepEqual(replies(e.handle(frameS21('RI'))),['06','02 53 49 35 38 31 2D 67 03']);
  assert.deepEqual(data(e.handle(frameS21('Ra'))),ascii('500-'));
  assert.deepEqual(data(e.handle(frameS21('F9'))).slice(0,2),[174,127]);
});

test('S21 signed 0xFFFF represents -0.1 C, without the TaiSEIA unavailable sentinel',()=>{
  const p=cloneProfile();setRaw(p,20,65535);
  const e=new S21Engine(p);
  assert.equal(e.value(20),-1);
  assert.equal(validateS21Value(e.service(20),65535),null);
  assert.equal(displayS21Value(e.service(20),65535),'-0.1 °C');
  assert.notEqual(validateS21Value(e.service(0),65535),null);
  assert.deepEqual(data(e.handle(frameS21('RH'))),ascii('100-'));
});

test('model, energy, fan RPM, and compressor frequency use their distinct reversed encodings',()=>{
  const p=cloneProfile();p.model='AB12';setRaw(p,26,0x3a52);setRaw(p,23,123);setRaw(p,24,7);
  const e=new S21Engine(p);
  assert.deepEqual(data(e.handle(frameS21('FC'))),ascii('21BA'));
  assert.deepEqual(data(e.handle(frameS21('FM'))),ascii('25A3'));
  assert.deepEqual(data(e.handle(frameS21('RL'))),ascii('321'));
  assert.deepEqual(data(e.handle(frameS21('Rd'))),ascii('700'));
});

test('D5, D6 and D7 update the mapped flags, acknowledge once, and reject reserved bits',()=>{
  const e=new S21Engine();
  for(const [cmd,payload] of [['D5',[0x37,0x3f,0x30,0x80]],['D6',[0xf2,0xb0,0x30,0x3c]],['D7',[0x94,0x32,0x30,0x30]]]){
    const r=e.handle(frameS21(cmd,payload));assert.equal(r.accepted,true);assert.deepEqual(replies(r),['06']);
  }
  assert.equal(e.value(4),7);
  for(const id of [6,7,8,9,10,11,12])assert.equal(e.value(id),1);
  assert.equal(e.value(13),100);
  assert.deepEqual(data(e.handle(frameS21('F6'))),[0xf2,0xb0,0x30,0x3c]);
  assert.deepEqual(data(e.handle(frameS21('F7'))),[0x94,0x32,0x30,0x30]);
  for(const [cmd,payload] of [['D5',[0x31,0x31,0x30,0x80]],['D6',[0x31,0x30,0x30,0x30]],['D7',[0x95,0x30,0x30,0x30]],['D7',[0x30,0x31,0x30,0x30]]]){
    const before=structuredClone(e.services),r=e.handle(frameS21(cmd,payload));
    assert.equal(r.accepted,false);assert.deepEqual(replies(r),['15']);assert.deepEqual(e.services,before);
  }
});

test('profile rejects NaN, noninteger, missing, duplicate, and out-of-range values',()=>{
  for(const bad of [NaN,Infinity,-Infinity,1.5,'1',null,-1,65536]){
    const p=cloneProfile();setRaw(p,0,bad);assert.throws(()=>validateS21Profile(p));
  }
  for(const delay of [NaN,Infinity,-1,2001,'0']){
    const p=cloneProfile();p.replyDelay=delay;assert.throws(()=>validateS21Profile(p));
  }
  for(const mutate of [p=>p.services.pop(),p=>p.services[1]=structuredClone(p.services[0]),p=>p.model='ABCDE',p=>p.model='空調00',p=>p.schema=2]){
    const p=cloneProfile();mutate(p);assert.throws(()=>validateS21Profile(p));
  }
});

test('imported service metadata cannot change supported commands or validation',()=>{
  const p=cloneProfile(),s=p.services.find(s=>s.id===1);
  Object.assign(s,{min:-999,max:999,enum:null,writable:false,scale:NaN,name:'changed',enabled:false});
  const e=new S21Engine(p),base=S21_PROFILE.services.find(s=>s.id===1);
  for(const key of ['min','max','enum','writable','scale','name','enabled'])assert.deepEqual(e.service(1)[key],base[key]);
  assert.equal(e.handle(frameS21('D1',[0x31,0x35,0x4e,0x41])).accepted,false);
  assert.equal(e.handle(D1).accepted,true);
});

test('raw response extensions preserve binary bytes and cannot override built-in queries',()=>{
  const p=cloneProfile();p.rawReplies={FZ:[0x00,0x80,0xfe,0xff],RZ:[0x31]};
  const e=new S21Engine(p);
  assert.deepEqual(data(e.handle(frameS21('FZ'))),[0x00,0x80,0xfe,0xff]);
  assert.equal(commandS21(e.handle(frameS21('FZ')).responses[1]),'GZ');
  assert.equal(commandS21(e.handle(frameS21('RZ')).responses[1]),'SZ');
  for(const table of [{F1:[0x30]},{FY00:[0x30]},{DZ:[0x30]},{FZ:[2]},{FZ:[3]},{FZ:[]},{FZ:[NaN]},{FZ:Array(65).fill(0x30)}]){
    const invalid=cloneProfile();invalid.rawReplies=table;assert.throws(()=>validateS21Profile(invalid));
  }
});

test('engines and imported profiles do not share mutable service or raw-reply state',()=>{
  const p=cloneProfile();p.rawReplies={FZ:[0x31]};const a=new S21Engine(p),b=new S21Engine(p);
  a.handle(D1);a.profile.rawReplies.FZ[0]=0x39;
  assert.equal(b.value(0),0);assert.equal(p.services.find(s=>s.id===0).raw,0);
  assert.deepEqual(data(b.handle(frameS21('FZ'))),[0x31]);assert.deepEqual(p.rawReplies.FZ,[0x31]);
});
