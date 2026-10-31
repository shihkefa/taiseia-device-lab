import {PROFILES} from './catalog.js';
import {DeviceEngine,frame,parseHex,hex,hexWord,xor,checkFrame,decode,displayValue as taiDisplayValue,validateProfile,validateValue as taiValidateValue,signed} from './protocol.js';
import {SerialTransport} from './serial.js';
import {Capture} from './capture.js';
import {initTranslator} from './translator-ui.js';
import {S21Engine,S21_PROFILE,S21_COMMANDS,frameS21,checkS21,checksumS21,decodeS21,validateS21Profile,validateS21Value,displayS21Value} from './s21.js';
import {DiscoveryParser,DiscoverySession,SERIAL_PRESETS} from './discovery.js';
const displayValue=(s,v)=>s.command?displayS21Value(s,v):taiDisplayValue(s,v);
const validateValue=(s,v,o)=>s.command?validateS21Value(s,v):taiValidateValue(s,v,o);
const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const engines=new Map(PROFILES.map(p=>[p.saId,new DeviceEngine(p)]));engines.set('s21',new S21Engine());
const isS21=()=>engine.profile.protocol==='s21';
const supportsUnknown=s=>!isS21()||s.unavailableWire===0x80;
const isUnknown=s=>supportsUnknown(s)&&s.raw===65535;
let lastTaiId=1,detectSource='未連線',scan={active:false,index:0,deadline:0,next:0,busy:false,generation:0};
let engine=engines.get(1),paused=false,filter='all',selectedId=null,renderPending=false,revision=0,serialOptions=null,mode='idle';
const parser=new DiscoveryParser(),discovery=new DiscoverySession(),capture=new Capture(),snapshots=new Map();
function snapshot(){revision++;snapshots.set(revision,structuredClone(engine.profile));}
snapshot();
function notify(message,success=false){$('notice').textContent=message;$('notice').classList.toggle('success',success);$('notice').hidden=false;}
function add(record){const entry=capture.add({profileRevision:revision,protocol:discovery.protocol||(isS21()?'s21':'taiseia'),...record});scheduleRender();return entry;}
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;renderStats();if(!paused)renderLog();});}
function serialFailure(error){add({direction:'SYS',kind:'event',source:'串口',error:true,description:error.message});notify(error.message);}
const transport=new SerialTransport({onData:bytes=>receive(bytes,'串口'),onError:serialFailure,onState:(connected,info,meta)=>{
  mode=connected?'serial':'idle';parser.clear();if(connected&&!meta?.reconfigured){resetDiscovery();detectSource='串口';}
  if(meta?.options){serialOptions=meta.options;$('baud').value=serialOptions.baudRate;$('data-bits').value=serialOptions.dataBits;$('parity').value=serialOptions.parity;$('stop-bits').value=serialOptions.stopBits;}
  $('connection-status').textContent=connected?'串口已連線':'未連線';
  $('connection-detail').textContent=connected?serialLabel(serialOptions)+' · 設備端':'設備端 · 等待控制器';
  $('connection-dot').classList.toggle('connected',connected);$('connect').hidden=connected;$('disconnect').hidden=!connected;
  lockPortControls(connected);
  $('send-status').disabled=!connected||isS21();
  if(!connected){stopScan();resetDiscovery();add({direction:'SYS',source:'串口',kind:'event',description:'連線已結束，待回覆排程與握手證據已清除'});syncSerialInputs();}
  renderDiscovery();
}});
let discoveryGeneration=0;
function lockPortControls(locked){for(const id of ['protocol-mode','serial-mode','baud','data-bits','parity','stop-bits','device-type','auto-device','demo','inject','test-command','import-profile','rescan'])$(id).disabled=locked;document.querySelectorAll('#quick-commands button').forEach(b=>b.disabled=locked);}
const serialLabel=o=>`${o.baudRate} · ${o.dataBits}${o.parity[0].toUpperCase()}${o.stopBits}`;
const presetOptions=key=>({...SERIAL_PRESETS[key],flowControl:'none',bufferSize:4096});
const manualOptions=()=>({baudRate:Number($('baud').value),dataBits:Number($('data-bits').value),parity:$('parity').value,stopBits:Number($('stop-bits').value),flowControl:'none',bufferSize:4096});
function scanCandidates(){const setting=$('protocol-mode').value;if(setting!=='auto')return [setting];return isS21()?['s21','taiseia']:['taiseia','s21'];}
function resetDiscovery(){++discoveryGeneration;parser.reset($('protocol-mode').value);discovery.reset({protocol:$('protocol-mode').value,deviceId:engine.profile.saId,autoDevice:$('auto-device').checked});detectSource=transport?.connected?'串口':'未連線';renderDiscovery();}
function stopScan(){scan.active=false;scan.generation++;}
function startScan(){scan.active=true;scan.deadline=performance.now()+60000;scan.next=performance.now()+4000;scan.index=0;scan.generation++;renderDiscovery();}
async function tickScan(){
  if(!scan.active||scan.busy||performance.now()<scan.next)return;
  if(discovery.protocol){stopScan();return;}
  if(performance.now()>=scan.deadline){stopScan();notify('60 秒內尚未收到有效命令。可重新偵測，或固定協議並重啟控制器，讓它再次查詢。');renderDiscovery();return;}
  scan.busy=true;const generation=scan.generation;
  try{scan.index=(scan.index+1)%2;serialOptions=presetOptions(scanCandidates()[scan.index]);parser.reset($('protocol-mode').value);if(await transport.reconfigure(serialOptions)&&generation===scan.generation){scan.next=performance.now()+4000;add({direction:'SYS',source:'串口',kind:'event',description:'自動偵測切換 '+serialLabel(serialOptions),serialOptions});}}
  catch(e){stopScan();notify('自動切換串口參數失敗：'+e.message);}
  finally{scan.busy=false;renderDiscovery();}
}
function syncSerialInputs(){
  const automatic=$('serial-mode').value==='auto';
  if(automatic&&!transport.connected){const preset=SERIAL_PRESETS[scanCandidates()[0]];$('baud').value=preset.baudRate;$('data-bits').value=preset.dataBits;$('parity').value=preset.parity;$('stop-bits').value=preset.stopBits;}
  for(const id of ['baud','data-bits','parity','stop-bits'])$(id).disabled=transport.connected||automatic;
}
function renderDiscovery(){
  const protocol=discovery.protocol,offline=detectSource==='離線',prefix=offline?'離線示範 · ':'';
  $('detected-protocol').textContent=prefix+(protocol==='s21'?'Daikin S21':protocol==='taiseia'?'TaiSEIA':'尚未偵測');
  $('protocol-evidence').textContent=protocol?'依完整控制器命令與校驗確認；本輪已鎖定':'單一 ACK、雜訊或開啟串口不算辨識成功';
  const identified=['target-sa','s21-family'].includes(discovery.deviceBasis);
  $('detected-device').textContent=identified?engine.profile.name:protocol==='taiseia'?'已宣告／預設 '+engine.profile.name:'待控制器定址';
  $('device-evidence').textContent=discovery.deviceBasis==='target-sa'?'依控制器目標 SA 確認':discovery.deviceBasis==='s21-family'?'S21 空調族；不能由查詢識別實際型號':'SA=00 共通查詢不含設備類型，使用所選模擬設備';
  const labels={waiting:'等待命令',detected:'協議已辨識',responding:'已回覆，待確認','identity-sent':'已回覆設備識別',established:'握手流程完成（定址）','waiting-ack':'等待控制器 ACK',confirmed:'握手已確認（ACK）','no-ack':'後續查詢，未收到 ACK','ack-timeout':'控制器 ACK 逾時',rejected:'控制器拒絕回覆'};
  const stale=transport.connected&&discovery.lastRx!==null&&performance.now()-discovery.lastRx>15000;
  $('handshake-state').textContent=prefix+(stale?'最近 15 秒未收到有效命令':labels[discovery.stage]);
  $('handshake-state').className=!stale&&['confirmed','established'].includes(discovery.stage)?'confirmed':['ack-timeout','rejected'].includes(discovery.stage)?'warning':'';
  $('handshake-evidence').textContent=discovery.evidence+(offline?'；僅離線測試，非實體控制器':'');
  $('scan-status').textContent=scan.active?`偵測中 · ${serialLabel(serialOptions)} · 每組 4 秒 · 剩餘 ${Math.max(0,Math.ceil((scan.deadline-performance.now())/1000))} 秒`:transport.connected?`${serialLabel(serialOptions)} · ${protocol?'協議已鎖定':'等待控制器；可按重新偵測'}`:$('serial-mode').value==='auto'?($('protocol-mode').value==='auto'?'自動：9600 8N1 ↔ 2400 8E2；選取 COM 後開始':'固定 '+($('protocol-mode').value==='s21'?'S21 · 2400 8E2':'TaiSEIA · 9600 8N1')+'；選取 COM 後開始'):'使用手動串口參數；依有效封包辨識協議';
  $('rescan').disabled=scan.busy||transport.opening;
}
$('rescan').addEventListener('click',async()=>{
  if(transport.opening)return;stopScan();resetDiscovery();
  if(!transport.connected){notify('辨識狀態已重設，可以注入另一種協議或開始串口連線。',true);return;}
  scan.busy=true;
  try{serialOptions=$('serial-mode').value==='auto'?presetOptions(scanCandidates()[0]):serialOptions;if(await transport.reconfigure(serialOptions)){if($('serial-mode').value==='auto'&&$('protocol-mode').value==='auto')startScan();notify('已重新開始偵測，請讓控制器再次送出查詢。',true);}}
  catch(e){notify(e.message);}
  finally{scan.busy=false;renderDiscovery();}
});
$('protocol-mode').addEventListener('change',()=>{
  const protocol=$('protocol-mode').value;
  if(protocol==='s21')engine=engines.get('s21');else if(protocol==='taiseia'&&isS21())engine=engines.get(lastTaiId);
  snapshot();resetDiscovery();renderDevice();syncSerialInputs();
});
$('serial-mode').addEventListener('change',()=>{syncSerialInputs();renderDiscovery();});
$('auto-device').addEventListener('change',()=>resetDiscovery());
$('s21-apply').addEventListener('click',()=>{
  try{const p=structuredClone(engine.profile);p.model=$('s21-model').value;p.replyDelay=Number($('s21-delay').value);p.rawReplies={};
    for(const line of $('s21-raw').value.split(/\r?\n/).filter(s=>s.trim())){const match=line.match(/^\s*([FR][A-Za-z0-9])\s*:\s*(.+)$/);if(!match||Object.hasOwn(p.rawReplies,match[1]))throw Error('每行請填入不重複的「命令: HEX payload」');p.rawReplies[match[1]]=Array.from(parseHex(match[2]));}
    engine.profile=validateS21Profile(p);snapshot();settingsFromProfile();notify('S21 設定已套用。',true);
  }catch(e){notify(e.message);}
});
function renderS21Detail(r){
  const control=r.bytes.length===1,valid=control||checkS21(r.bytes);
  $('packet-detail').innerHTML=`<div class="byte-grid">${r.bytes.map((b,i)=>`<div class="byte"><strong>${hex([b])}</strong><small>${control?'ACK/NAK':i===0?'STX':i===r.bytes.length-1?'ETX':i===r.bytes.length-2?'SUM':i<3?'CMD':`DATA ${i-3}`}</small></div>`).join('')}</div><div class="detail-description">${escape(r.description)}<br>${control?'單一控制字元；不以此單獨辨識協議':`SUM：${hex([checksumS21(r.bytes.slice(1,-2))])} · ${valid?'驗證通過':'不符'} · 特殊值 02/03/06/15 加 2`}${r.requestId?` · 回覆 #${r.requestId} · ${r.latencyMs} ms`:''}${r.changes?'<br>'+r.changes.map(c=>`欄位 ${c.id}：${hexWord(c.before)} → ${hexWord(c.after)}`).join(' / '):''}<br>設定檔版本 ${r.profileRevision} · ${escape(r.timestamp)}</div>`;
}

document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!==button.dataset.tab);document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b===button));}));
function renderSummary(){const power=engine.service(0),preferred=isS21()?3:{1:3,3:2,4:3,8:1,14:21,15:2}[engine.profile.saId],s=engine.service(preferred);$('state-summary').innerHTML=`<div><small>電源</small><strong>${power?.enabled?(power.raw===65535?'未知':power.raw===0?'關機':'開機'):'未提供'}</strong></div><div><small>${escape(s?.name||'功能')}</small><strong style="font-size:${s?.enum?'1rem':'1.5rem'}">${s?.enabled?escape(displayValue(s,s.raw)):'未提供'}</strong></div>`;}
function renderFields(){const search=$('service-search').value.trim().toLowerCase();const rows=engine.services.filter(s=>`${s.name} ${s.id.toString(16).padStart(2,'0')}`.toLowerCase().includes(search));$('device-fields').innerHTML=rows.map(s=>{const id=`value-${s.id}`,value=s.signed?signed(s.raw):s.raw;return `<div class="service-field"><label for="${id}" title="${escape(s.rangeBasis)}">${escape(s.name)}<small>${s.command||'0x'+hex([s.id])} · ${s.writable?'R/W':'R'}${s.unit?' · '+escape(s.unit):''}</small></label><div class="unit-value">${s.enum?`<select id="${id}" data-value="${s.id}" ${isUnknown(s)?'disabled':''}>${Object.entries(s.enum).map(([k,v])=>`<option value="${k}" ${Number(k)===s.raw?'selected':''}>${k} · ${escape(v)}</option>`).join('')}</select>`:`<input id="${id}" data-value="${s.id}" type="number" min="${s.min*s.scale}" max="${s.max*s.scale}" step="${s.scale}" value="${isUnknown(s)?'':Number((value*s.scale).toFixed(4))}" ${isUnknown(s)?'disabled':''}>`}</div><label class="service-unknown" ${supportsUnknown(s)?'':'hidden'}><input type="checkbox" data-unknown="${s.id}" ${isUnknown(s)?'checked':''}>${isS21()?'未指定／不適用 (80)':'無資料 FFFF'}${s.confidence.includes('待')?' · '+escape(s.confidence):''}</label></div>`;}).join('')||'<p class="no-fields">沒有符合條件的功能，可至協定設定啟用。</p>';
  $('device-fields').querySelectorAll('[data-value]').forEach(input=>input.addEventListener('change',()=>{const s=engine.service(Number(input.dataset.value));const value=Number(input.value)/(s.enum?1:s.scale);if(!Number.isFinite(value)||Math.abs(value-Math.round(value))>0.00001||input.value===''){notify('請輸入符合步進的數值');renderFields();return;}const raw=Math.round(value)&65535;const error=validateValue(s,raw,{local:true});if(error||value<s.min||value>s.max){notify(error||'數值超出範圍');renderFields();return;}const before=s.raw;s.raw=raw;add({direction:'LOCAL',kind:'event',source:'手動',description:`${s.name} · ${displayValue(s,before)} → ${displayValue(s,raw)}`,change:{id:s.id,before,after:raw}});renderSummary();}));
  $('device-fields').querySelectorAll('[data-unknown]').forEach(input=>input.addEventListener('change',()=>{const s=engine.service(Number(input.dataset.unknown)),before=s.raw;const original=(isS21()?S21_PROFILE:PROFILES.find(p=>p.saId===engine.profile.saId))?.services.find(f=>f.id===s.id);s.raw=input.checked?65535:(original?.raw??s.min)&65535;if(validateValue(s,s.raw,{local:true}))s.raw=(s.enum?Number(Object.keys(s.enum)[0]):s.min)&65535;add({direction:'LOCAL',kind:'event',source:'手動',description:`${s.name} · ${displayValue(s,s.raw)}`,change:{id:s.id,before,after:s.raw}});renderFields();renderSummary();}));
}
function updateInputs(){renderSummary();for(const s of engine.services){const input=$(`value-${s.id}`),unknown=document.querySelector(`[data-unknown="${s.id}"]`);if(input&&document.activeElement!==input){input.disabled=isUnknown(s);input.value=isUnknown(s)?'':s.enum?s.raw:Number(((s.signed?signed(s.raw):s.raw)*s.scale).toFixed(4));}if(unknown)unknown.checked=isUnknown(s);}}
function settingsFromProfile(){const p=engine.profile;$('tai-settings').hidden=isS21();$('s21-settings').hidden=!isS21();if(isS21()){$('s21-model').value=p.model;$('s21-delay').value=p.replyDelay;$('s21-raw').value=Object.entries(p.rawReplies).map(([k,v])=>k+': '+hex(v)).join('\n');$('s21-command-list').textContent=Object.entries(S21_COMMANDS).map(([k,v])=>k+' '+v).join('　/　');return;}$('brand').value=p.brand;$('model').value=p.model;$('protocol-version').value=p.version.join('.');$('device-kind').value=p.registerByte5;$('class-id').value=p.classId;$('reply-delay').value=p.replyDelay;$('invalid-policy').value=p.invalidPolicy;$('services-format').value=p.servicesFormat;}
function renderCapabilities(){if(isS21())return;$('capability-table').innerHTML=engine.profile.services.map(s=>`<tr><td><input type="checkbox" data-enable="${s.id}" aria-label="支援 ${escape(s.name)}" ${s.enabled?'checked':''}></td><td><code>0x${hex([s.id])}</code></td><td>${escape(s.name)}<br><small title="${escape(s.rangeBasis)}">${s.min}–${s.max}${s.writeValues?' · 寫入僅重設0':''}</small></td><td><input type="checkbox" data-writable="${s.id}" aria-label="允許寫入 ${escape(s.name)}" ${s.writable?'checked':''}></td><td><input type="text" maxlength="4" data-cap="${s.id}" aria-label="${escape(s.name)} 能力值" value="${hexWord(s.capability)}" title="${escape(s.capabilityBasis)}"></td><td><span class="source-note" title="${escape(s.source)}">${escape(s.confidence)}</span><br><span class="source-note">${escape(s.capabilityBasis)}</span></td></tr>`).join('');
  $('capability-table').querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{const p=structuredClone(engine.profile),id=Number(input.dataset.enable??input.dataset.writable??input.dataset.cap),s=p.services.find(s=>s.id===id);if(input.dataset.enable!==undefined)s.enabled=input.checked;else if(input.dataset.writable!==undefined){s.writable=input.checked;s.confidence='使用者調整讀寫權限';}else{if(!/^[0-9a-f]{4}$/i.test(input.value)){notify('能力值須為 4 碼 HEX');renderCapabilities();return;}s.capability=parseInt(input.value,16);s.capabilityBasis='使用者設定原始值';}try{validateProfile(p);engine.profile=p;snapshot();add({direction:'LOCAL',source:'設定',kind:'event',description:`已修改 ${s.name} 支援／存取／能力值`});renderFields();renderSummary();renderCapabilities();}catch(e){notify(e.message);renderCapabilities();}}));
}
function renderDevice(){const p=engine.profile;$('device-name').textContent=p.name;$('sa-chip').textContent=isS21()?'DAIKIN S21':`SA 0x${hex([p.saId])}`;$('capability-device').textContent=p.name;$('profile-confidence').textContent=p.confidence;$('device-type').value=p.saId;$('send-status').hidden=isS21();$('send-status').disabled=!transport.connected||isS21();renderSummary();renderFields();settingsFromProfile();renderCapabilities();renderQuick();syncSerialInputs();}
function renderQuick(){const commands=isS21()?[['讀狀態 F1',frameS21('F1')],['版本 F8',frameS21('F8')],['室溫 RH',frameS21('RH')],['開機 D1',frameS21('D1',[49,51,80,65])],['控制器 ACK',Uint8Array.of(6)]]:[['註冊',frame(0,0,65535)],['完整狀態',frame(0,8,65535)],['功能清單',frame(0,7,65535)],['讀電源',frame(engine.profile.saId,0,65535)],['開機',frame(engine.profile.saId,128,1)],['關機',frame(engine.profile.saId,128,0)]];$('quick-commands').innerHTML=commands.map(([label,bytes])=>`<button data-hex="${hex(bytes)}" ${transport.connected?'disabled':''}>${label}<code> ${hex(bytes)}</code></button>`).join('');$('quick-commands').querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{$('test-command').value=button.dataset.hex;inject();}));}
function receive(bytes,source){detectSource=source;add({direction:'RX',kind:'chunk',source,protocol:discovery.protocol||'unknown',bytes,description:'原始接收區塊 · '+bytes.length+' bytes'});for(const event of parser.push(bytes))processEvent(event,source);renderDiscovery();}
function processEvent(event,source){
  if(event.type==='error'){add({direction:'RX',source,protocol:event.protocol,kind:'error',error:true,bytes:event.bytes,description:event.reason});return;}
  const bytes=event.bytes,protocol=event.protocol;
  if(event.type==='control'){const ack=discovery.control(bytes[0]);add({direction:'RX',source,protocol,kind:'frame',bytes,description:decodeS21(bytes)+' · '+ack.reason,error:bytes[0]===21});renderDiscovery();return;}
  if(!discovery.protocol&&protocol==='taiseia'&&discovery.deviceId==='s21')discovery.deviceId=lastTaiId;
  const observed=discovery.observe(protocol,bytes);
  if(observed.accepted){
    if(scan.active){stopScan();add({direction:'SYS',kind:'event',source,protocol,description:'已鎖定 '+protocol+' · '+(serialOptions?serialLabel(serialOptions):'離線')});}
    if(engine.profile.saId!==observed.deviceId){engine=engines.get(observed.deviceId);if(!isS21())lastTaiId=engine.profile.saId;snapshot();renderDevice();}
  }
  const entry=add({direction:'RX',source,protocol,kind:'frame',bytes,checksumValid:true,description:protocol==='s21'?decodeS21(bytes):decode(bytes,engine.profile,'RX')});
  if(!observed.accepted){entry.description+=' · '+observed.reason;entry.error=true;capture.counts.error++;return;}
  if(!$('auto-reply').checked){entry.description+=' · 自動回覆已停用';return;}
  const result=engine.handle(bytes);entry.description=result.reason;entry.accepted=result.accepted;entry.change=result.change;entry.changes=result.changes;
  if(!result.accepted){entry.error=true;capture.counts.error++;}
  updateInputs();
  const responses=protocol==='s21'?result.responses:result.response?[result.response]:[];
  if(!responses?.length)return;
  if(protocol==='taiseia'&&bytes[1]===0&&[0,4].includes(bytes[2]))discovery.declared=true;
  const profile=structuredClone(engine.profile),rev=revision,session=discoveryGeneration;
  const sent=()=>{for(const response of responses){add({direction:'TX',source,protocol,kind:'frame',bytes:response,profileRevision:rev,requestId:entry.id,latencyMs:Number((performance.now()-entry.monotonicMs).toFixed(3)),checksumValid:true,description:protocol==='s21'?decodeS21(response):decode(response,profile,'TX',bytes),format:protocol==='taiseia'&&bytes[1]===0&&bytes[2]===0?'registration':profile.servicesFormat==='bare'&&bytes[1]===0&&bytes[2]===7?'bare-services':'standard',error:!result.accepted});if(session===discoveryGeneration&&result.accepted)discovery.sent(protocol,bytes,response);}renderDiscovery();};
  if(source==='串口')transport.send(Uint8Array.from(responses.flatMap(b=>Array.from(b))),profile.replyDelay,sent).catch(()=>{});else sent();
}
setInterval(()=>{for(const event of parser.expire())processEvent(event,mode==='serial'?'串口':'離線');if(discovery.expire())renderDiscovery();if(discovery.lastRx!==null)renderDiscovery();void tickScan();},100);
function renderStats(){$('rx-count').textContent=capture.counts.RX;$('tx-count').textContent=capture.counts.TX;$('error-count').textContent=capture.counts.error;$('log-count').textContent=capture.records.length;$('dropped-count').textContent=capture.dropped?`已移除最早 ${capture.dropped} 筆 · 請定期匯出`:'所有記錄僅保留在此瀏覽器工作階段';}
function renderLog(){const search=$('log-search').value.trim().toLowerCase();const items=capture.records.filter(r=>($('show-chunks').checked||r.kind!=='chunk')&&(filter==='all'||filter==='error'&&r.error||r.direction===filter)&&(!search||`${hex(r.bytes)} ${r.description} ${r.source} ${r.protocol}`.toLowerCase().includes(search)));const el=$('packet-log'),atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-55;el.innerHTML=items.length?items.slice(-600).map(r=>{const date=new Date(r.timestamp),time=date.toLocaleTimeString('zh-TW',{hour12:false})+'.'+String(date.getMilliseconds()).padStart(3,'0');return `<button class="packet-row ${r.error?'error':''} ${r.id===selectedId?'selected':''}" data-record="${r.id}"><span><time>${time}</time><span class="direction ${r.direction==='TX'?'tx':''}">${escape(r.direction)}</span><span class="source">${escape(r.source)} · ${escape(r.protocol==='s21'?'S21':r.protocol==='taiseia'?'TaiSEIA':'待辨識')} / #${r.id}</span></span><span class="hex">${r.bytes.length?hex(r.bytes):'—'}${r.kind==='chunk'?'<small> RAW</small>':''}</span><span class="description">${escape(r.description)}</span></button>`;}).join(''):`<div class="empty-state"><span class="empty-icon">⌁</span><h3>${capture.records.length?'沒有符合的紀錄':'等待第一個封包'}</h3><p>連接串口，或先執行離線測試。</p></div>`;el.querySelectorAll('[data-record]').forEach(row=>row.addEventListener('click',()=>{selectedId=Number(row.dataset.record);renderDetail();el.querySelectorAll('.selected').forEach(e=>e.classList.remove('selected'));row.classList.add('selected');}));if(atBottom)el.scrollTop=el.scrollHeight;$('capture-state').textContent=paused?'畫面已暫停 · 擷取與回覆持續':`即時顯示 · ${items.length>600?'畫面顯示最新600筆，匯出保留全部':'重複封包逐筆保留'}`;}
function renderDetail(){const r=capture.records.find(r=>r.id===selectedId);$('translate-selected').disabled=!r||!r.bytes.length;if(!r){$('selected-id').textContent='選取一筆紀錄查看';$('packet-detail').textContent='逐位元組檢視長度、設備、功能、資料與 XOR。';return;}$('selected-id').textContent=`#${r.id} · ${r.source} · ${r.bytes.length} bytes`;if(r.protocol==='s21'){renderS21Detail(r);return;}const frameKind=r.kind==='frame';$('packet-detail').innerHTML=`<div class="byte-grid">${r.bytes.map((b,i)=>`<div class="byte"><strong>${hex([b])}</strong><small>${(!frameKind||r.format==='bare-services'&&i>0&&i<r.bytes.length-1)?`[${i}]`:i===0?'LEN':i===1?'SA':i===2?'SERVICE':i===r.bytes.length-1?'XOR':r.bytes.length===6?(i===3?'DATA HI':'DATA LO'):`[${i}]`}</small></div>`).join('')}</div><div class="detail-description">${escape(r.description)}${frameKind?`<br>XOR：${hex([xor(r.bytes.slice(0,-1))])} · ${checkFrame(r.bytes)?'驗證通過':'不符'}`:''}${r.requestId?` · 回覆 #${r.requestId} · ${r.latencyMs} ms`:''}${r.change?`<br>狀態變更 0x${hex([r.change.id])}：${hexWord(r.change.before)} → ${hexWord(r.change.after)}`:''}<br>設定檔版本 ${r.profileRevision} · ${escape(r.timestamp)}</div>${tupleDetail(r)}`;}
function inject(){if(transport.connected||transport.opening)return notify('實體連線期間停用離線命令，避免混淆擷取來源');try{mode='offline';receive(parseHex($('test-command').value),'離線');notify('離線命令已送入同一個設備引擎；未使用實體串口。',true);}catch(e){notify(e.message);}}
$('inject').addEventListener('click',inject);
$('demo').addEventListener('click',()=>{if(transport.connected||transport.opening)return;resetDiscovery();$('auto-reply').checked=true;mode='offline';if(isS21()){
  const f1=frameS21('F1');receive(f1.slice(0,2),'離線');receive(f1.slice(2),'離線');receive(Uint8Array.of(6),'離線');receive(frameS21('D1',[49,51,76,53]),'離線');receive(frameS21('F1'),'離線');receive(Uint8Array.of(6),'離線');receive(frameS21('RH'),'離線');receive(Uint8Array.of(6),'離線');notify('S21 離線示範已完成：查詢、ACK、控制與讀回。此確認來自示範資料，尚未使用實體串口。',true);return;}
  const p=engine.profile,sample={1:[3,26],3:[2,2],4:[3,55],8:[1,3],14:[21,1],15:[2,3]}[p.saId],requests=[frame(0,0,65535),frame(0,7,65535),frame(p.saId,128,1),frame(p.saId,128|sample[0],sample[1]),frame(p.saId,sample[0],65535),frame(0,8,65535)];receive(requests[0].slice(0,2),'離線');receive(Uint8Array.from([...requests[0].slice(2),...requests.slice(1).flatMap(b=>Array.from(b))]),'離線');notify(p.name+' 離線註冊、讀寫與狀態查詢完成；所有握手證據標記為離線。',true);
});
$('connect').addEventListener('click',async()=>{
  if(!isSecureContext)return notify('Web Serial 需要 HTTPS 或 localhost');
  resetDiscovery();detectSource='串口';scan.index=0;
  serialOptions=$('serial-mode').value==='auto'?presetOptions(scanCandidates()[0]):manualOptions();
  $('connect').disabled=true;lockPortControls(true);
  try{if(!await transport.connect(serialOptions))return;snapshot();add({direction:'SYS',source:'串口',kind:'event',description:'已連接 · '+serialLabel(serialOptions),serialOptions});if($('serial-mode').value==='auto'&&$('protocol-mode').value==='auto')startScan();notify('串口已連接，正在等待控制器查詢；有效封包會自動辨識並回覆。',true);}
  catch(e){notify(e.name==='NotFoundError'?'已取消串口選擇':e.message);}
  finally{$('connect').disabled=false;lockPortControls(transport.connected);syncSerialInputs();renderDiscovery();}
});
$('disconnect').addEventListener('click',async()=>{$('disconnect').disabled=true;await transport.disconnect();$('disconnect').disabled=false;});
$('send-status').addEventListener('click',()=>{const bytes=engine.status();transport.send(bytes,0,()=>add({direction:'TX',kind:'frame',source:'串口',bytes,checksumValid:true,description:'手動送出完整狀態'})).catch(()=>{});});
$('device-type').addEventListener('change',()=>{engine=engines.get($('device-type').value==='s21'?'s21':Number($('device-type').value));if(!isS21())lastTaiId=engine.profile.saId;if($('protocol-mode').value!=='auto')$('protocol-mode').value=isS21()?'s21':'taiseia';$('service-search').value='';snapshot();resetDiscovery();renderDevice();syncSerialInputs();add({direction:'LOCAL',kind:'event',source:'設定',description:'選定模擬設備：'+engine.profile.name});});
$('reset-state').addEventListener('click',()=>{const base=isS21()?S21_PROFILE:PROFILES.find(p=>p.saId===engine.profile.saId);for(const s of engine.profile.services){const original=base.services.find(f=>f.id===s.id);s.raw=original?.raw??((s.enum?Number(Object.keys(s.enum)[0]):s.min)&65535);if(validateValue(s,s.raw,{local:true}))s.raw=65535;}snapshot();renderFields();renderSummary();add({direction:'LOCAL',kind:'event',source:'手動',description:'設備狀態已重設為模擬初值'});});
$('service-search').addEventListener('input',renderFields);
$('log-search').addEventListener('input',()=>{if(!paused)renderLog();});$('show-chunks').addEventListener('change',()=>{if(!paused)renderLog();});
document.querySelectorAll('[data-direction]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.direction;document.querySelectorAll('[data-direction]').forEach(b=>b.classList.toggle('active',b===button));if(!paused)renderLog();}));
$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'恢復畫面':'暫停畫面';$('capture-state').textContent=paused?'畫面已暫停 · 擷取與回覆持續':'即時顯示 · 重複封包逐筆保留';if(!paused)renderLog();});
$('clear-log').addEventListener('click',()=>{capture.clear();selectedId=null;const current=structuredClone(engine.profile);revision++;snapshots.set(revision,current);renderStats();renderLog();renderDetail();});
$('auto-reply').addEventListener('change',()=>add({direction:'LOCAL',kind:'event',source:'設定',description:`自動回覆${$('auto-reply').checked?'啟用':'停用'}（已排入的回覆仍會完成）`}));
for(const id of ['brand','model','protocol-version','device-kind','class-id','reply-delay','invalid-policy','services-format'])$(id).addEventListener('change',()=>{const p=structuredClone(engine.profile);p.brand=$('brand').value;p.model=$('model').value;p.version=$('protocol-version').value.split('.').map(Number);p.registerByte5=Number($('device-kind').value);p.classId=Number($('class-id').value);p.replyDelay=Number($('reply-delay').value);p.invalidPolicy=$('invalid-policy').value;p.servicesFormat=$('services-format').value;try{validateProfile(p);engine.profile=p;snapshot();add({direction:'LOCAL',kind:'event',source:'設定',description:'設備識別／回覆設定已更新'});notify('設定已套用，後續查詢會使用新設定。',true);}catch(e){notify(e.message);settingsFromProfile();}});
function download(name,data,type){const url=URL.createObjectURL(new Blob([data],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-');
function tupleDetail(record){
  const b=record.bytes,p=snapshots.get(record.profileRevision);if(record.protocol==='s21'||record.direction!=='TX'||record.kind!=='frame'||!p)return '';
  let start,capabilities=false;
  if(record.format==='bare-services'){start=1;capabilities=true;}
  else if(record.format!=='registration'&&b[1]===0&&[7,8].includes(b[2])){start=3;capabilities=b[2]===7;}
  else if(b[1]===0&&b[2]===p.classId&&b.length>=11){const brandEnd=b.indexOf(0,8),modelEnd=b.indexOf(0,brandEnd+1);if(brandEnd<8||modelEnd<brandEnd)return '';start=modelEnd+1;capabilities=true;}
  else return '';
  const rows=[];for(let i=start;i+2<b.length-1;i+=3){const id=capabilities?b[i]&127:b[i],s=p.services.find(s=>s.id===id),raw=(b[i+1]<<8)|b[i+2];rows.push(`<tr><td><code>0x${hex([id])}</code></td><td>${escape(s?.name||'未知功能')}</td><td><code>${hexWord(raw)}</code></td><td>${escape(capabilities?`${b[i]&128?'R/W':'R'} · ${s?.capabilityBasis||'原始能力值'}`:s?displayValue(s,raw):String(raw))}</td></tr>`);}
  return `<div class="table-scroll tuple-table"><table><thead><tr><th>ID</th><th>功能</th><th>原始值</th><th>${capabilities?'讀寫／能力依據':'解碼數值'}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
$('export-json').addEventListener('click',()=>download(`taiseia-capture-${stamp()}.json`,JSON.stringify({schema:'device-lab-capture-v2',discovery:{...discovery,source:detectSource},exportedAt:new Date().toISOString(),timeMeaning:'monotonicMs is browser performance.now; TX is writer.write completed. S21 ACK is a separate RX record. Offline source is simulated.',dropped:capture.dropped,serialOptions,profiles:Object.fromEntries(snapshots),records:capture.records},null,2),'application/json'));
$('export-csv').addEventListener('click',()=>download(`taiseia-capture-${stamp()}.csv`,capture.csv(),'text/csv;charset=utf-8'));
$('export-profile').addEventListener('click',()=>download(`taiseia-profile-${engine.profile.saId}.json`,JSON.stringify(engine.profile,null,2),'application/json'));
$('import-profile').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(transport.connected)throw Error('請先中斷串口再匯入設定');if(file.size>512000)throw Error('設定檔大小超過 500KB');const raw=JSON.parse(await file.text()),p=raw.protocol==='s21'?validateS21Profile(raw):validateProfile(raw);const base=p.protocol==='s21'?S21_PROFILE:PROFILES.find(x=>x.saId===p.saId);p.name=base.name;p.confidence='使用者匯入設定 · 請依目標機型校對';engine=p.protocol==='s21'?new S21Engine(p):new DeviceEngine(p);engines.set(p.saId,engine);if(!isS21())lastTaiId=p.saId;snapshot();$('protocol-mode').value='auto';resetDiscovery();renderDevice();syncSerialInputs();add({direction:'LOCAL',kind:'event',source:'設定',description:`已匯入 ${p.name} 設定`});notify('設備設定已匯入。',true);}catch(e){notify(e.message);}event.target.value='';});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&transport.connected)add({direction:'SYS',kind:'event',source:'串口',description:'頁面進入背景；瀏覽器可能延遲回覆計時'});});
window.addEventListener('beforeunload',event=>{if(transport.connected){event.preventDefault();event.returnValue='';}});
const translator=initTranslator({getCapture:()=>({schema:'device-lab-capture-v2',records:capture.records,profiles:Object.fromEntries(snapshots)}),openTab:()=>{document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!=='translator');document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab==='translator'));}});
$('translate-selected').addEventListener('click',()=>{const r=capture.records.find(r=>r.id===selectedId);if(!r||!r.bytes.length)return;if(r.kind!=='frame'){translator.loadBytes(r.bytes,{direction:r.direction,protocol:r.protocol,deviceId:snapshots.get(r.profileRevision)?.saId});return;}const request=capture.records.find(p=>p.id===r.requestId);translator.loadCapture({records:request?[request,r]:[r],profiles:Object.fromEntries(snapshots)});});
renderDevice();renderStats();syncSerialInputs();renderDiscovery();
if(!('serial' in navigator))notify('這個瀏覽器不支援 Web Serial。可執行離線測試；實體連線請使用桌面版 Chrome 或 Edge。');
// Browser tools intentionally cannot select, connect, write to, or alter a live port.
if(navigator.modelContext?.registerTool){try{navigator.modelContext.registerTool({name:'inspect_taiseia_lab',description:'Read current device configuration and recent packet records; no serial I/O.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true},execute:async()=>({content:[{type:'text',text:JSON.stringify({device:engine.profile,connected:transport.connected,discovery:{...discovery,source:detectSource},serialOptions,counts:capture.counts,records:capture.records.slice(-20)})}]})});}catch{}}
