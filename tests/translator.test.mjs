import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePacket,translateText,translateCapture,translationText} from '../dist/translator.js';
import {PROFILES} from '../dist/catalog.js';
import {S21_PROFILE} from '../dist/s21.js';

// Literal wire vectors calculated independently of the implementation's encoders.
// They exercise public mappings; they are not claimed to be hardware captures.
const bytes=text=>text.split(/\s+/).map(value=>parseInt(value,16));
const F1='02 46 31 77 03';
const D1='02 44 31 31 33 4E 41 68 03';
const G1='02 47 31 31 33 4E 41 6B 03';
const REGISTRATION='50 00 00 04 00 03 00 01 48 49 54 41 43 48 49 00 52 41 44 2D 35 30 4E 4B 00 '+
  '80 00 03 81 00 1F 82 00 1F 83 10 20 04 00 28 86 05 A0 8B 05 A0 8C 05 A0 97 00 03 '+
  '9A 00 03 9B 00 03 9D 00 3F 9E 00 03 21 E9 28 A8 FF FF 29 00 55 AF 52 58 B0 03 20 E9';
const decode=(text,options={})=>decodePacket(bytes(text),options);
const value=(packet,label)=>packet.fields.find(field=>field.label===label)?.value;
const warnings=packet=>packet.warnings.join('\n');
const frozen=object=>{if(object&&typeof object==='object'){Object.values(object).forEach(frozen);Object.freeze(object);}return object;};

test('F1 query has no invented state fields; D1 and G1 preserve distinct roles',()=>{
  const query=decode(F1,{direction:'RX'});
  assert.equal(query.protocol,'s21');
  assert.equal(query.checksum.valid,true);
  assert.match(query.summary,/F1.*查詢/);
  assert.equal(value(query,'設定溫度'),undefined);
  for(const [wire,direction,command] of [[D1,'RX','D1'],[G1,'TX','G1']]) {
    const packet=decode(wire,{direction});
    assert.equal(packet.direction,direction);
    assert.equal(packet.checksum.valid,true);
    assert.match(value(packet,'命令'),new RegExp(command));
    assert.equal(value(packet,'電源'),'開機');
    assert.match(value(packet,'模式'),/冷房/);
    assert.match(value(packet,'設定溫度'),/^25 °C/);
    assert.match(value(packet,'風速'),/自動/);
    assert.equal(packet.fields.find(field=>field.label==='設定溫度').offset,5);
  }
  assert.match(warnings(decode(G1,{direction:'RX'})),/方向/);
  assert.match(warnings(decode(D1,{direction:'TX'})),/方向/);
});

test('S21 sensor numbers decode reversed decimal digits and preserve negative tenths',()=>{
  for(const [wire,expected] of [
    ['02 53 48 30 33 32 2B 5B 03','23 °C'],
    ['02 53 49 35 38 31 2D 67 03','-18.5 °C'],
    ['02 53 61 31 30 30 2D 72 03','-0.1 °C'],
    ['02 53 4C 33 32 31 35 03','1230 RPM'],
    ['02 53 64 37 30 30 4E 03','7 Hz'],
    ['02 53 65 30 35 30 4D 03','50 %'],
  ]) {
    const packet=decode(wire,{direction:'TX'});
    assert.equal(packet.checksum.valid,true);
    assert(packet.fields.some(field=>field.value===expected),`${wire}: ${expected}`);
    assert.doesNotMatch(packet.summary,/NaN|undefined|無資料/);
  }
});

test('G9 coarse temperature FF is unavailable rather than 63.5 degrees',()=>{
  const packet=decode('02 47 39 AE 7F FF 30 DC 03');
  assert.equal(packet.checksum.valid,true);
  assert.equal(value(packet,'室內溫度'),'23 °C');
  assert.equal(value(packet,'室外溫度'),'-0.5 °C');
  const absent=decode('02 47 39 FF FF FF 30 AD 03');
  assert.equal(absent.checksum.valid,true);
  assert.match(value(absent,'室內溫度'),/無資料/);
  assert.match(value(absent,'室外溫度'),/無資料/);
  assert.doesNotMatch(absent.summary,/63\.5/);
});

test('model and energy use distinct reversed ASCII and hexadecimal encodings',()=>{
  const model=decode('02 47 43 32 31 42 41 70 03');
  const energy=decode('02 47 4D 32 35 41 33 6F 03');
  assert.equal(model.checksum.valid,true);
  assert.equal(energy.checksum.valid,true);
  assert.equal(value(model,'型號代碼（倒序 ASCII）'),'AB12');
  assert.doesNotMatch(model.summary,/模擬型號/);
  assert.match(value(energy,'累積耗電'),/0x3A52.*1493 kWh/);
});

test('G8 accepts both simulator ASCII tails and real-unit NUL tails without asserting v3 absence',()=>{
  for(const wire of ['02 47 38 30 32 30 30 41 03','02 47 38 30 32 00 00 E1 03']) {
    const packet=decode(wire);
    assert.equal(packet.checksum.valid,true);
    assert.match(value(packet,'舊式版本欄位'),/版本值 2/);
    assert.match(warnings(packet),/不能.*排除 v3/);
  }
});

test('S21 swing, special flags and demand keep their own byte mappings',()=>{
  const swing=decode('02 47 35 37 3F 30 80 A2 03');
  const flags=decode('02 47 36 F2 B0 30 3C 8B 03');
  const demand=decode('02 47 37 94 32 30 30 A4 03');
  assert.equal(value(swing,'擺風'),'上下＋左右');
  assert.equal(value(flags,'特殊模式旗標'),'強力 開／舒適 開／室外靜音 開');
  assert.equal(value(flags,'Streamer'),'開');
  assert.match(value(flags,'感測／指示燈旗標'),/人體感測 開.*指示燈位元 開/);
  assert.match(value(demand,'需求節能量'),/^100%/);
  assert.equal(value(demand,'節能模式'),'開');
  for(const packet of [swing,flags,demand])assert.equal(packet.checksum.valid,true);
});

test('valid checksums do not hide invalid payload lengths, enums, digits or signs',()=>{
  for(const [wire,warning] of [
    ['02 44 31 32 33 4E 41 69 03',/未定義.*列舉/],
    ['02 44 31 31 35 4E 41 6A 03',/未定義.*列舉/],
    ['02 47 31 31 33 4E 2A 03',/長度應為 4/],
    ['02 53 48 41 33 32 2B 6C 03',/三個倒序數字/],
    ['02 53 48 30 33 32 30 60 03',/三個倒序數字/],
  ]) {
    const packet=decode(wire);
    assert.equal(packet.checksum.valid,true,wire);
    assert.equal(packet.status,'warning');
    assert.match(warnings(packet),warning);
    assert.doesNotMatch(packet.summary,/NaN|undefined/);
  }
});

test('all reserved S21 checksum values are escaped without pretending payload validity',()=>{
  for(const [payload,wireChecksum] of [['8B','04'],['8C','05'],['8F','08'],['9E','17']]) {
    const packet=decode(`02 46 31 ${payload} ${wireChecksum} 03`);
    assert.equal(packet.checksum.valid,true);
    assert.equal(packet.checksum.expected,parseInt(wireChecksum,16));
    assert.match(warnings(packet),/查詢通常不含 payload/);
  }
});

test('S21 unknown binary replies and extended requests retain bytes without invented semantics',()=>{
  for(const wire of [
    '02 47 5A 00 80 FE FF 1E 03',
    '02 46 59 30 30 FF 03',
    '02 4D 4D 03','02 56 56 03','02 56 53 30 30 30 4D 86 03',
  ]) {
    const packet=decode(wire);
    assert.equal(packet.checksum.valid,true);
    assert.deepEqual(packet.bytes,bytes(wire));
    assert(packet.warnings.length>0);
  }
  const extended=decode('02 46 59 30 30 FF 03');
  assert.match(value(extended,'命令'),/^FY00/);
  assert.equal(extended.fields.find(field=>field.label==='命令').length,4);
  assert.equal(decode('02 56 53 30 30 30 4D 86 03').fields.find(field=>field.label==='命令').length,6);
});

test('bare ACK is ambiguous in auto mode and cannot establish a handshake when specified as S21',()=>{
  const unknown=decode('06');
  assert.equal(unknown.protocol,'unknown');
  assert.equal(unknown.direction,'auto');
  assert.match(unknown.summary,/可能.*ACK/);
  assert.equal(unknown.checksum,null);
  for(const [wire,label] of [['06','ACK'],['15','NAK']]) {
    const packet=decode(wire,{protocol:'s21',direction:'RX'});
    assert.equal(packet.protocol,'s21');
    assert.match(packet.summary,new RegExp(label));
    assert.equal(packet.checksum,null);
    assert.match(warnings(packet),/不能單獨證明握手完成/);
  }
});

test('TaiSEIA write echo and FFFF read value ambiguity require direction context',()=>{
  const wire='06 01 83 00 1A 9E';
  assert.match(decode(wire).summary,/寫入命令／echo/);
  assert.match(warnings(decode(wire)),/完全相同/);
  assert.match(decode(wire,{direction:'RX'}).summary,/寫入命令/);
  assert.match(decode(wire,{direction:'TX'}).summary,/寫入回覆/);
  const sentinel='06 01 04 FF FF 03';
  assert.match(decode(sentinel).summary,/讀取請求／FFFF 無資料回覆/);
  assert.equal(value(decode(sentinel,{direction:'RX'}),'DATA HI / LO'),'FFFF 查詢值');
  assert.match(value(decode(sentinel,{direction:'TX'}),'DATA HI / LO'),/無資料/);
});

test('TaiSEIA uses the packet SA namespace and decodes signed and scaled values',()=>{
  const negative=decode('06 01 21 FF FB 22',{direction:'TX'});
  const current=decode('06 01 24 00 17 34',{direction:'TX'});
  const humidity=decode('06 04 83 00 37 B6',{direction:'RX',deviceId:1});
  assert.equal(negative.checksum.valid,true);
  assert.equal(value(negative,'DATA HI / LO'),'-5 °C');
  assert.equal(value(current,'DATA HI / LO'),'2.3 A');
  assert.equal(humidity.deviceId,4,'a numeric SA takes precedence over a selected common namespace');
  assert.match(value(humidity,'DATA HI / LO'),/55 %/);
});

test('TaiSEIA registration identifies the embedded device and terminated text',()=>{
  const packet=decode(REGISTRATION,{direction:'TX',deviceId:4});
  assert.equal(packet.checksum.valid,true);
  assert.equal(packet.deviceId,1);
  assert.equal(value(packet,'品牌（NUL 結尾）'),'HITACHI');
  assert.equal(value(packet,'型號（NUL 結尾）'),'RAD-50NK');
  assert.match(packet.summary,/註冊回覆/);
  assert.equal(packet.fields.find(field=>field.label==='SA Type').offset,6);
  assert(packet.fields.some(field=>field.label==='能力原始值'));
});

test('common status needs device context while a preceding SA Type reply can supply it',()=>{
  const status='07 00 08 07 00 3C 34';
  const unknown=decode(status,{direction:'TX'});
  assert.equal(unknown.deviceId,null);
  assert.match(warnings(unknown),/不含設備類型/);
  assert.equal(unknown.fields.some(field=>field.value==='60 %'),false);
  const result=translateText(`TX: 06 00 04 00 04 06\nTX: ${status}`);
  assert.equal(result.packets.length,2);
  assert.equal(result.packets[1].deviceId,4);
  assert(result.packets[1].fields.some(field=>field.value==='60 %'));
});

test('standard and bare capability tables preserve raw capability words and write bits',()=>{
  const standard=decode('0A 00 07 80 00 03 83 10 20 3D',{deviceId:1,direction:'TX'});
  const bare=decode('08 80 00 03 83 10 20 38',{deviceId:1,direction:'TX',format:'bare-services'});
  for(const packet of [standard,bare]) {
    assert.equal(packet.checksum.valid,true);
    assert.equal(packet.fields.filter(field=>field.label==='能力原始值').length,2);
    assert(packet.fields.some(field=>field.label==='能力原始值'&&field.raw==='10 20'));
    assert(packet.fields.some(field=>field.label==='功能 ID / bit7 存取'&&/可寫入/.test(field.value)));
  }
  assert.match(bare.summary,/精簡服务|精簡服務/);
  const inferred=translateText('RX: 06 00 07 FF FF 01\nTX: 08 80 00 03 83 10 20 38',{deviceId:1});
  assert.match(inferred.packets[1].summary,/精簡服務/);
});

test('incomplete TaiSEIA tuple and FF error reply warn without inventing functional values',()=>{
  const partial=decode('08 00 08 04 00 1B 21 3E',{deviceId:1,direction:'TX'});
  assert.equal(partial.checksum.valid,true);
  assert.match(warnings(partial),/不是 3 的倍數/);
  assert.equal(value(partial,'未完成功能資料'),'不足一組 ID + HI + LO');
  const error=decode('06 04 FF 00 01 FC',{direction:'TX'});
  assert.equal(error.checksum.valid,true);
  assert.match(error.summary,/錯誤回覆/);
  assert.match(warnings(error),/不解作功能值/);
});

test('checksum errors retain the original bytes and calculated checksum without repair',()=>{
  for(const [wire,expected,actual] of [
    ['02 46 31 76 03',0x77,0x76],['06 01 83 00 1A 9F',0x9E,0x9F],
  ]) {
    const packet=decode(wire);
    assert.equal(packet.checksum.valid,false);
    assert.equal(packet.checksum.expected,expected);
    assert.equal(packet.checksum.actual,actual);
    assert.equal(packet.status,'error');
    assert.deepEqual(packet.bytes,bytes(wire));
    assert.match(warnings(packet),/不會修補或執行/);
  }
});

test('all field offsets and raw bytes refer to the unchanged original packet',()=>{
  for(const wire of [F1,D1,G1,REGISTRATION,'06 01 83 00 1A 9E','02 53 49 35 38 31 2D 67 03']) {
    const packet=decode(wire);
    for(const field of packet.fields) {
      assert(Number.isInteger(field.offset)&&field.offset>=0);
      assert(Number.isInteger(field.length)&&field.length>0);
      assert(field.offset+field.length<=packet.bytes.length);
      assert.deepEqual(bytes(field.raw),packet.bytes.slice(field.offset,field.offset+field.length));
    }
  }
});

test('split HEX lines and coalesced mixed-protocol frames preserve every packet',()=>{
  const stream=`${F1} 06 ${G1} 06 06 01 83 00 1A 9E`;
  const expected=[bytes(F1),[6],bytes(G1),[6],bytes('06 01 83 00 1A 9E')];
  const all=bytes(stream);
  for(let split=1;split<all.length;split++) {
    const text=all.slice(0,split).map(n=>n.toString(16).padStart(2,'0')).join(' ')+'\n'+
      all.slice(split).map(n=>n.toString(16).padStart(2,'0')).join(' ');
    assert.deepEqual(translateText(text).packets.map(packet=>packet.bytes),expected,`split ${split}`);
  }
});

test('RX/TX prefixes supply direction, timestamps and comments are not parsed as bytes',()=>{
  const result=translateText(`[2026-09-30T01:02:03.123Z] RX: ${F1} # query\n01:02:03.456 TX: 06 ${G1}\nRX: 06`);
  assert.deepEqual(result.packets.map(packet=>packet.direction),['RX','TX','TX','RX']);
  assert.deepEqual(result.packets.map(packet=>packet.protocol),['s21','s21','s21','s21']);
  assert.deepEqual(result.packets.map(packet=>packet.bytes),[bytes(F1),[6],bytes(G1),[6]]);
});

test('noise and incomplete tails are preserved while following valid frames recover',()=>{
  const result=translateText(`FF 7F ${F1} 06 00`);
  assert.equal(result.packets[0].protocol,'unknown');
  assert.deepEqual(result.packets[0].bytes,[255,127]);
  assert(result.packets.some(packet=>packet.hex===F1&&packet.checksum.valid));
  assert.deepEqual(result.packets.flatMap(packet=>packet.bytes),bytes(`FF 7F ${F1} 06 00`));
  assert(result.packets.at(-1).warnings.length>0);
});

test('a corrupt S21 prefix cannot swallow the next complete valid request',()=>{
  const result=translateText(`02 7F 7F ${F1}`);
  assert.deepEqual(result.packets.flatMap(packet=>packet.bytes),bytes(`02 7F 7F ${F1}`));
  assert(result.packets.some(packet=>packet.hex===F1&&packet.checksum.valid),
    'recover a complete valid frame starting at the second STX');
});

test('invalid HEX is rejected strictly instead of silently dropping characters',()=>{
  for(const input of ['', '   ', '# only comment', '06 0', '06 GG', '06 01 xyz',
    'RX: 06 01 83 00 1A 9E junk', '{broken JSON}', '[6,1,0,255,255,7]']) {
    assert.throws(()=>translateText(input),undefined,input);
  }
  const parsed=translateText('0x02:46,31-77 03');
  assert.deepEqual(parsed.packets[0].bytes,bytes(F1));
});

test('byte, text, packet and capture-record limits reject excessive input',()=>{
  assert.throws(()=>translateText('0'.repeat(1_000_001)),/1MB/);
  assert.throws(()=>translateText('00 '.repeat(65537)),/64KB/);
  assert.throws(()=>translateText((F1+' ').repeat(2001)),/2000/);
  assert.throws(()=>translateCapture({records:Array.from({length:10001},()=>({kind:'chunk'}))}),/10000/);
  for(const invalid of [[],[NaN],[256],[-1],[1.5],null,'06'])assert.throws(()=>decodePacket(invalid));
});

test('capture import skips duplicate chunks but preserves repeated complete frames',()=>{
  const capture={records:[
    {id:1,kind:'chunk',direction:'RX',protocol:'s21',bytes:bytes(F1)},
    {id:2,kind:'frame',direction:'RX',protocol:'s21',bytes:bytes(F1),source:'串口'},
    {id:3,kind:'frame',direction:'TX',protocol:'s21',bytes:[6],requestId:2},
    {id:4,kind:'frame',direction:'TX',protocol:'s21',bytes:bytes(G1),requestId:2},
    {id:5,kind:'event',direction:'LOCAL',bytes:[]},
    {id:6,kind:'chunk',direction:'RX',protocol:'s21',bytes:bytes(F1)},
    {id:7,kind:'frame',direction:'RX',protocol:'s21',bytes:bytes(F1),source:'串口'},
  ]};
  const result=translateCapture(capture);
  assert.equal(result.source,'capture');
  assert.equal(result.skipped,3);
  assert.deepEqual(result.packets.map(packet=>packet.recordId),[2,3,4,7]);
  assert.deepEqual(result.packets.map(packet=>packet.bytes),[bytes(F1),[6],bytes(G1),bytes(F1)]);
  assert.equal(translateText(JSON.stringify(capture)).packets.length,4);
  assert.throws(()=>translateCapture({records:[capture.records[0]]}),/沒有完整/);
});

test('decode and capture translation do not mutate bytes, options, profiles or capture snapshots',()=>{
  const profile=structuredClone(PROFILES.find(profile=>profile.saId===1));
  const service=profile.services.find(service=>service.id===3);
  service.name='測試自訂欄位';service.scale=2;service.unit='X';
  delete service.confidence;
  const capture=frozen({profiles:{1:profile},records:[
    {id:1,profileRevision:1,kind:'frame',direction:'TX',protocol:'taiseia',bytes:bytes('06 01 03 00 1A 1E')},
  ]});
  const before=JSON.stringify({capture,PROFILES,S21_PROFILE});
  const options=frozen({protocol:'taiseia',direction:'TX',deviceId:1,profile});
  const input=frozen(bytes('06 01 03 00 1A 1E'));
  assert.match(decodePacket(input,options).summary,/測試自訂欄位.*52 X/);
  assert.match(translateCapture(capture).packets[0].summary,/測試自訂欄位.*52 X/);
  assert.equal(JSON.stringify({capture,PROFILES,S21_PROFILE}),before);
  assert.deepEqual(input,bytes('06 01 03 00 1A 1E'));
  assert.equal(options.profile,profile);
});

test('text export includes packet bytes, offset interpretations and warnings without executing commands',()=>{
  const result=translateText(`RX: ${D1}\nTX: 06`);
  const before=JSON.stringify(result);
  const output=translationText(result);
  assert.match(output,/D1/);
  assert.match(output,/25 °C/);
  assert.match(output,/\[5\] 設定溫度: 4E/);
  assert.match(output,/ACK/);
  assert.match(output,/不能單獨證明握手完成/);
  assert.equal(JSON.stringify(result),before);
});

test('capture request context requires a valid checksum before inferring bare services',()=>{
  const capture=checksum=>({records:[
    {id:1,kind:'frame',direction:'RX',protocol:'taiseia',bytes:bytes(`06 00 07 FF FF ${checksum}`)},
    {id:2,kind:'frame',direction:'TX',protocol:'taiseia',requestId:1,bytes:bytes('08 80 00 03 83 10 20 38')},
  ]});
  const valid=translateCapture(capture('01'),{deviceId:1});
  assert.equal(valid.packets[0].checksum.valid,true);
  assert.match(valid.packets[1].summary,/精簡服務/);
  const corrupt=translateCapture(capture('00'),{deviceId:1});
  assert.equal(corrupt.packets[0].checksum.valid,false);
  assert.equal(corrupt.packets[1].checksum.valid,true);
  assert.doesNotMatch(corrupt.packets[1].summary,/精簡服務/);
});

test('status bytes resembling registration text retain standard status semantics by default',()=>{
  const wire='13 00 08 00 00 01 21 00 23 24 00 20 28 41 00 29 00 00 5C';
  const packet=decode(wire,{direction:'TX',deviceId:1});
  assert.equal(packet.checksum.valid,true);
  assert.match(packet.summary,/完整狀態/);
  assert.equal(packet.deviceId,1);
  assert.equal(packet.fields.filter(field=>field.label==='功能 ID').length,5);
  assert.equal(value(packet,'品牌（NUL 結尾）'),undefined);
  assert(packet.warnings.some(warning=>/註冊/.test(warning)));
  const explicit=decode(wire,{direction:'TX',format:'registration'});
  assert.equal(explicit.checksum.valid,true);
  assert.match(explicit.summary,/註冊回覆/);
  assert.equal(explicit.deviceId,0x2100);
  const matched=translateCapture({records:[
    {id:1,kind:'frame',direction:'RX',protocol:'taiseia',bytes:bytes('06 00 00 FF FF 06')},
    {id:2,kind:'frame',direction:'TX',protocol:'taiseia',requestId:1,bytes:bytes(wire)},
  ]});
  assert.match(matched.packets[1].summary,/註冊回覆/);
});

test('typed registration retains extension bytes that are not three-byte capability tuples',()=>{
  const packet=decode('0F 00 80 04 00 03 00 01 41 00 42 00 AA BB 9B',{direction:'TX'});
  assert.equal(packet.checksum.valid,true);
  assert.match(packet.summary,/註冊回覆/);
  assert.equal(packet.deviceId,1);
  assert.equal(value(packet,'品牌（NUL 結尾）'),'A');
  assert.equal(value(packet,'型號（NUL 結尾）'),'B');
  const extension=packet.fields.find(field=>field.label==='擴充功能資料');
  assert.equal(extension.raw,'AA BB');
  assert.equal(extension.length,2);
  assert.match(warnings(packet),/bit7=1/);
});

test('a corrupt TaiSEIA length prefix does not swallow a later complete frame',()=>{
  const prefix='0C 01 24 00 17 34',valid='06 01 24 00 17 34';
  const result=translateText(`${prefix} ${valid}`);
  assert.deepEqual(result.packets.flatMap(packet=>packet.bytes),bytes(`${prefix} ${valid}`));
  assert.deepEqual(result.packets[0].bytes,bytes(prefix));
  assert(result.packets[0].warnings.length>0);
  assert.equal(result.packets.at(-1).hex,valid);
  assert.equal(result.packets.at(-1).checksum.valid,true);
  assert.match(result.packets.at(-1).summary,/2\.3 A/);
});

test('capture learns the SA from a valid registration but never from a corrupt registration',()=>{
  const capture=registration=>({records:[
    {id:1,kind:'frame',direction:'TX',protocol:'taiseia',bytes:bytes(registration)},
    {id:2,kind:'frame',direction:'TX',protocol:'taiseia',bytes:bytes('0A 00 08 04 00 1B 21 FF FB 38')},
  ]});
  const good=translateCapture(capture(REGISTRATION));
  assert.equal(good.packets[0].deviceId,1);
  assert.equal(good.packets[1].deviceId,1);
  assert(good.packets[1].fields.some(field=>field.value==='27 °C'));
  assert(good.packets[1].fields.some(field=>field.value==='-5 °C'));
  const corrupt=translateCapture(capture(REGISTRATION.slice(0,-2)+'E8'));
  assert.equal(corrupt.packets[0].checksum.valid,false);
  assert.equal(corrupt.packets[1].deviceId,null);
  assert.equal(corrupt.packets[1].fields.some(field=>field.value==='27 °C'),false);
  assert.match(warnings(corrupt.packets[1]),/不含設備類型/);
});
