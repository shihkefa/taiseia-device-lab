import {PROFILES} from './catalog.js';
import {translateText,translateCapture,translationText} from './translator.js';
const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SAMPLES={
  tai:'RX: 06 01 83 00 1A 9E\nTX: 06 01 83 00 1A 9E\nRX: 06 01 03 FF FF 04\nTX: 06 01 03 00 1A 1E\nTX: 06 01 24 00 17 34',
  s21:'RX: 02 46 31 77 03\nTX: 06 02 47 31 31 33 4E 41 6B 03\nRX: 06\nRX: 02 52 61 B3 03\nTX: 06 02 53 61 31 30 30 2D 72 03\nRX: 06',
  damaged:'RX: 06 01 83 00 1A 9F\n06 01 03 FF FF 04\n02 53 48 41 33 32 2B 6C 03\n06'
};
export function initTranslator({getCapture,openTab}){
  let result=null,page=0;
  $('translator-device').innerHTML='<option value="auto">依封包／上下文</option>'+PROFILES.map(p=>`<option value="${p.saId}">${escape(p.name)} · SA ${p.saId.toString(16).toUpperCase().padStart(2,'0')}</option>`).join('');
  const options=()=>({protocol:$('translator-protocol').value||'auto',deviceId:$('translator-device').value||'auto',direction:$('translator-direction').value||'auto',format:$('translator-format').value||'standard'});
  function notice(text,error=false){$('translator-notice').textContent=text;$('translator-notice').classList.toggle('bad',error);}
  function resetOutput(){result=null;page=0;render();}
  function run(){try{result=translateText($('translator-input').value,options());page=0;render();notice(result.warnings.join(' ')||`已轉譯 ${result.packets.length} 筆；${result.skipped?`略過 ${result.skipped} 筆非 frame 紀錄。`:'不會修改設備狀態或傳送串口資料。'}`);}catch(e){resetOutput();notice(e.message,true);}}
  function loadCapture(data){try{const frames=data.records.filter(r=>r.kind==='frame'&&['RX','TX'].includes(r.direction));const ids=new Set(frames.map(r=>r.profileRevision));const reduced={schema:data.schema,records:frames,profiles:Object.fromEntries(Object.entries(data.profiles||{}).filter(([k])=>ids.has(Number(k))||ids.has(k)))};
      $('translator-protocol').value='auto';$('translator-direction').value='auto';$('translator-format').value='standard';$('translator-device').value='auto';
      const decoded=translateCapture(reduced,options()),text=JSON.stringify(reduced,null,2);if(text.length>1000000)throw Error('封包與設定快照超過 1MB，請選取單包轉譯，或分批匯入。');
      $('translator-input').value=text;$('translator-search').value='';$('translator-problems').checked=false;result=decoded;page=0;render();notice(`已載入 ${frames.length} 筆完整封包與設定快照；不重複分析原始接收區塊。${result.warnings.join(' ')}`);openTab();
    }catch(e){resetOutput();notice(e.message,true);openTab();}}
  function render(){
    const packets=result?.packets||[],term=$('translator-search').value.trim().toLowerCase();
    const filtered=packets.filter(p=>(!$('translator-problems').checked||p.status!=='valid')&&(!term||`${p.summary} ${p.hex} ${p.fields.map(f=>f.value).join(' ')} ${p.warnings.join(' ')}`.toLowerCase().includes(term)));
    const totalPages=Math.max(1,Math.ceil(filtered.length/20));page=Math.min(page,totalPages-1);
    $('translator-total').textContent=packets.length;$('translator-valid').textContent=packets.filter(p=>p.checksum?.valid).length;$('translator-invalid').textContent=packets.filter(p=>p.checksum?.valid===false).length;$('translator-uncertain').textContent=packets.filter(p=>p.warnings.length||p.protocol==='unknown').length;
    $('translator-page').textContent=`${filtered.length} 筆符合 · 第 ${page+1} / ${totalPages} 頁（每頁 20 筆）`;
    $('translator-prev').disabled=page===0;$('translator-next').disabled=page>=totalPages-1;
    for(const id of ['translation-json','translation-txt','translation-copy'])$(id).disabled=!packets.length;
    $('translator-results').innerHTML=filtered.length?filtered.slice(page*20,page*20+20).map((p,index)=>`<details class="translation-card ${p.status}" ${index===0?'open':''}><summary><span class="translation-index">#${p.index}</span><span class="translation-summary">${escape(p.summary)}<small>${escape(p.protocol==='s21'?'Daikin S21':p.protocol==='taiseia'?'TaiSEIA':'未辨識')} · ${escape(p.direction==='auto'?'方向未指定':p.direction==='RX'?'RX 控制器 → 設備':'TX 設備 → 控制器')}${p.recordId?' · 紀錄 #'+escape(p.recordId):''}</small></span><span class="translation-badge">${p.checksum?p.checksum.valid?'校驗通過':'校驗失敗':p.protocol==='unknown'?'待辨識':'控制字元'}</span></summary><div class="translation-body"><code class="translation-hex">${escape(p.hex)}</code>${p.warnings.length?`<ul class="translation-warnings">${p.warnings.map(w=>`<li>${escape(w)}</li>`).join('')}</ul>`:''}<div class="table-scroll"><table><thead><tr><th>位元組位置</th><th>欄位</th><th>原始 HEX</th><th>轉譯</th></tr></thead><tbody>${p.fields.map(f=>`<tr><td>${f.offset}${f.length>1?'–'+(f.offset+f.length-1):''}</td><td>${escape(f.label)}</td><td><code>${escape(f.raw)}</code></td><td>${escape(f.value)}</td></tr>`).join('')}</tbody></table></div></div></details>`).join(''):packets.length?'<div class="translation-empty"><strong>沒有符合條件的封包</strong><p>請調整搜尋文字，或取消「只看待確認」。</p></div>':'<div class="translation-empty"><strong>貼上封包，查看它說了什麼</strong><p>可以先載入 TaiSEIA 或 S21 範例；轉譯不需要連接串口。</p></div>';
  }
  function save(extension,data,type){const url=URL.createObjectURL(new Blob([data],{type})),link=document.createElement('a');link.href=url;link.download=`packet-translation-${new Date().toISOString().replace(/[:.]/g,'-')}.${extension}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('translator-run').addEventListener('click',run);
  $('translator-input').addEventListener('input',()=>{resetOutput();notice('輸入已變更，按「轉譯封包」重新分析。');});
  for(const id of ['translator-protocol','translator-device','translator-direction','translator-format'])$(id).addEventListener('change',()=>{if($('translator-input').value.trim())run();});
  $('translator-search').addEventListener('input',()=>{page=0;render();});$('translator-problems').addEventListener('change',()=>{page=0;render();});
  $('translator-prev').addEventListener('click',()=>{page--;render();});$('translator-next').addEventListener('click',()=>{page++;render();});
  for(const [id,key] of [['translation-sample-tai','tai'],['translation-sample-s21','s21'],['translation-sample-errors','damaged']])$(id).addEventListener('click',()=>{$('translator-input').value=SAMPLES[key];$('translator-protocol').value=key==='tai'?'taiseia':key==='s21'?'s21':'auto';$('translator-direction').value='auto';$('translator-format').value='standard';$('translator-device').value='auto';$('translator-search').value='';$('translator-problems').checked=false;run();});
  $('translator-load-capture').addEventListener('click',()=>loadCapture(getCapture()));
  $('translator-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>1000000)throw Error('檔案超過 1MB，請分批分析。');$('translator-input').value=await file.text();run();}catch(e){resetOutput();notice(e.message,true);}event.target.value='';});
  $('translation-json').addEventListener('click',()=>{if(result)save('json',JSON.stringify({schema:'packet-translation-v1',exportedAt:new Date().toISOString(),...result},null,2),'application/json');});
  $('translation-txt').addEventListener('click',()=>{if(result)save('txt',translationText(result),'text/plain;charset=utf-8');});
  $('translation-copy').addEventListener('click',async()=>{if(!result)return;try{await navigator.clipboard.writeText(translationText(result));notice('已複製完整轉譯報告。');}catch{notice('無法寫入剪貼簿；可改用「下載 TXT」。',true);}});
  function loadBytes(bytes,settings={}){
    $('translator-input').value=Array.from(bytes,b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
    $('translator-protocol').value=['taiseia','s21'].includes(settings.protocol)?settings.protocol:'auto';$('translator-direction').value=['RX','TX'].includes(settings.direction)?settings.direction:'auto';$('translator-device').value=PROFILES.some(p=>p.saId===settings.deviceId)?String(settings.deviceId):'auto';$('translator-format').value='standard';$('translator-search').value='';$('translator-problems').checked=false;run();openTab();
  }
  render();return {loadCapture,loadBytes};
}
