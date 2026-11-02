import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILES} from '../dist/catalog.js';
import {frame,hex} from '../dist/protocol.js';
import {S21Engine,frameS21,S21_PROFILE} from '../dist/s21.js';
import {CN105Engine,frameCN105,queryCN105,connectCN105,sampleSetCN105,CN105_PROFILE} from '../dist/cn105.js';
import {decodePacket,translateText,translateCapture} from '../dist/translator.js';
import {taiTranslationSample} from '../dist/translator-samples.js';
import {initTranslator} from '../dist/translator-ui.js';
const field=(p,label)=>p.fields.find(f=>f.label===label);

test('each selectable TaiSEIA device has a valid sample with its own type, read, write and full status',()=>{
  for(const profile of PROFILES){
    const sample=taiTranslationSample(profile.saId),result=translateText(sample.text);
    assert.equal(sample.name,profile.name);assert.equal(result.packets.length,7);
    assert.ok(result.packets.every(p=>p.checksum.valid));
    assert.equal(result.packets[3].deviceId,profile.saId);
    assert.equal(result.packets[6].deviceId,profile.saId);
    assert.equal(result.packets[6].fields.filter(f=>f.label==='數值').length,4);
    assert.ok(result.packets.every(p=>!p.warnings.some(w=>/未定義|未知功能/.test(w))),sample.name);
  }
  assert.equal(taiTranslationSample('auto').deviceId,1);
});

test('single-character S21 unknown commands never consume their checksum as command data',()=>{
  const p=decodePacket([2,65,65,3]);assert.equal(p.checksum.valid,true);assert.match(field(p,'命令').value,/^A ·/);assert.equal(field(p,'命令').length,1);assert.equal(field(p,'SUM').offset,2);assert.ok(p.warnings.length);
});
test('unknown CN105 TYPE with empty payload is pending interpretation, not an unqualified valid packet',()=>{
  const p=decodePacket(frameCN105(0x63));assert.equal(p.checksum.valid,true);assert.equal(p.status,'warning');assert.match(p.warnings.join(' '),/未知|未支援/);
});
test('CN105 known ACK and request lengths are checked independently of checksum validity',()=>{
  for(const type of [0x41,0x42,0x5a,0x61,0x62,0x7a]){const p=decodePacket(frameCN105(type));assert.equal(p.checksum.valid,true);assert.match(p.warnings.join(' '),/長度/);assert.ok(p.fields.every(f=>f.length>0));}
});

// Independent values and units, chosen by SA namespace from the published
// TaiXia mappings. These are synthetic protocol fixtures, not hardware captures.
const golden=[
  [1,'空調',36,23,'2.3 A'],[1,'空調',33,65531,'-5 °C'],
  [3,'洗衣機',2,10,'Quick wash (10)'],[3,'洗衣機',30,123,'12.3 kWh'],
  [4,'除濕機',3,55,'55 %'],[4,'除濕機',6,65531,'-5 °C'],
  [8,'空氣清淨機',1,3,'Standard (3)'],[8,'空氣清淨機',13,120,'120 W'],
  [14,'全熱交換器',21,1,'Full (1)'],[14,'全熱交換器',22,2,'60mins (2)'],
  [15,'電風扇',2,5,'5'],[15,'電風扇',11,60,'60 min'],
];
for(const [sa,name,sid,raw,expected] of golden)test(`${name} SA ${sa} function ${sid}: fixed namespace and physical value`,()=>{
  const p=decodePacket(frame(sa,sid,raw),{direction:'TX',deviceId:sa===1?4:1});assert.equal(p.device,name);assert.equal(field(p,'DATA HI / LO').value,expected);assert.equal(p.checksum.valid,true);
});

// Exhaustive schema-level coverage complements the independent fixed vectors:
// each catalog field must survive single reads, common status and capture import.
for(const profile of PROFILES)test(`${profile.name}: all ${profile.services.length} catalog fields decode in both addressed and common status packets`,()=>{
  const data=[];
  for(const s of profile.services){
    const samples=[...new Set([s.raw,s.min&65535,s.max&65535,...Object.keys(s.enum||{}).map(Number),65535])];
    for(const raw of samples){
      const p=decodePacket(frame(profile.saId,s.id,raw),{direction:'TX'});assert.equal(p.deviceId,profile.saId);assert.ok(field(p,'SERVICE').value.includes(s.name));
      const expected=raw===65535?'無資料（FFFF）':s.enum&&!Object.hasOwn(s.enum,raw)?'未定義列舉值 '+raw:s.enum?`${s.enum[raw]} (${raw})`:`${Number(((s.signed&&raw>=32768?raw-65536:raw)*s.scale).toFixed(4))}${s.unit?' '+s.unit:''}`;
      assert.equal(field(p,'DATA HI / LO').value,expected,s.name+' raw '+raw);
      assert.equal(field(decodePacket(frame(profile.saId,s.id,65535),{direction:'RX'}),'DATA HI / LO').value,'FFFF 查詢值');
    }
    data.push(s.id,s.raw>>>8,s.raw&255);
  }
  const status=frame(0,8,data),selected=decodePacket(status,{direction:'TX',deviceId:profile.saId});
  assert.equal(selected.fields.filter(f=>f.label==='數值').length,profile.services.length);for(const s of profile.services)assert.ok(selected.fields.some(f=>f.label==='功能 ID'&&f.value===s.name));
  const withContext=translateText('TX: '+hex(frame(0,4,profile.saId))+'\nTX: '+hex(status));assert.equal(withContext.packets[1].deviceId,profile.saId);
  const capture=translateCapture({profiles:{1:profile},records:[{kind:'frame',protocol:'taiseia',direction:'TX',profileRevision:1,bytes:Array.from(status)}]});assert.equal(capture.packets[0].fields.filter(f=>f.label==='數值').length,profile.services.length);
});

test('S21 all simulated numeric sensors and writable command families translate with their units',()=>{
  const e=new S21Engine();
  for(const [cmd,label,expected] of [['RH','溫度（倒序十進位 0.1°C）','27 °C'],['RI','溫度（倒序十進位 0.1°C）','18.5 °C'],['Ra','溫度（倒序十進位 0.1°C）','30 °C'],['RL','倒序數值','900 RPM'],['Rd','倒序數值','42 Hz'],['Re','倒序數值','50 %']]){const p=decodePacket(e.handle(frameS21(cmd)).responses[1],{direction:'TX'});assert.equal(field(p,label).value,expected);}
  for(const cmd of ['F1','F5','F6','F7','F8','F9','FC','FM']){const p=decodePacket(e.handle(frameS21(cmd)).responses[1],{direction:'TX'});assert.equal(p.checksum.valid,true);assert.doesNotMatch(p.summary,/NaN|undefined/);assert.ok(p.fields.length>=5);}
  for(const [cmd,data,label] of [['D1',[49,51,78,65],'設定溫度'],['D5',[55,63,48,128],'擺風'],['D6',[242,176,48,60],'Streamer'],['D7',[148,50,48,48],'需求節能量']])assert.ok(field(decodePacket(frameS21(cmd,data),{direction:'RX'}),label));
});
test('CN105 every simulated readback field is represented, including sensors and extended modes',()=>{
  const e=new CN105Engine();const cases=[
    [2,['電源','模式','設定溫度','風速','上下風向','左右風向','i-See 感測旗標']],
    [3,['室外溫度','室內溫度','運轉時間']], [4,['故障資訊']], [6,['壓縮機頻率','壓縮機運轉（獨立模擬值）','輸入功率','累積耗電']],
    [9,['運轉子模式','運轉階段','自動子模式']], [0x42,['空氣淨化','夜間模式','循環模式']],
  ];
  for(const [code,labels] of cases){const p=decodePacket(e.handle(queryCN105(code)).responses[0],{direction:'TX'});assert.equal(p.checksum.valid,true);for(const name of labels)assert.ok(field(p,name),name);}
  for(const b of [connectCN105(),sampleSetCN105(),frameCN105(0x41,[7,1,0,178,...Array(12).fill(0)]),frameCN105(0x41,[8,0,28,...Array(9).fill(0),1,1,1,0])]){const p=decodePacket(b,{direction:'RX'});assert.equal(p.checksum.valid,true);assert.doesNotMatch(p.summary,/NaN|undefined/);}
});

test('S21 configurable raw replies preserve every byte and remain marked as pending interpretation',()=>{
  const e=new S21Engine();
  for(const [cmd,payload] of Object.entries(S21_PROFILE.rawReplies)){
    const response=e.handle(frameS21(cmd)).responses[1],p=decodePacket(response,{direction:'TX'});
    assert.equal(p.checksum.valid,true);assert.deepEqual(p.bytes,Array.from(response));
    assert.deepEqual(p.bytes.slice(3,-2),payload);assert.ok(p.warnings.length,cmd);
    assert.ok(field(p,'未解碼 DATA'),cmd);
  }
});

test('translator file handler imports all six device snapshots, rejects oversized or malformed files and clears stale results',async t=>{
  const elements=new Map(),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,disabled:false,textContent:'',innerHTML:'',classList:{toggle(){}},handlers:new Map(),addEventListener(type,handler){this.handlers.set(type,handler);}});return elements.get(id);};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:element}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  initTranslator({getCapture:()=>{throw Error('must not capture or access serial');},openTab:()=>{throw Error('file import should stay in translator');}});
  const capture={records:[],profiles:{}};
  for(const p of PROFILES){capture.profiles[p.saId]=p;capture.records.push({kind:'frame',direction:'TX',protocol:'taiseia',profileRevision:p.saId,bytes:Array.from(frame(p.saId,p.services[0].id,p.services[0].raw))});}
  const importFile=async file=>{const target={files:[file],value:'file.json'};await element('translator-file').handlers.get('change')({target});assert.equal(target.value,'');};
  await importFile({size:100,text:async()=>JSON.stringify(capture)});
  assert.equal(element('translator-total').textContent,6);assert.equal(element('translator-invalid').textContent,0);
  for(const p of PROFILES)assert.ok(element('translator-results').innerHTML.includes(p.name));
  assert.equal(element('translation-json').disabled,false);
  await importFile({size:1000001,text:()=>{throw Error('oversized file must not be read');}});
  assert.equal(element('translator-total').textContent,0);assert.equal(element('translation-json').disabled,true);assert.match(element('translator-notice').textContent,/超過 1MB/);
  await importFile({size:1,text:async()=>'{' });
  assert.equal(element('translator-total').textContent,0);assert.match(element('translator-notice').textContent,/JSON 格式無法解析/);
});
