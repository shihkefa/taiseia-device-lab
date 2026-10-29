// Passive analysis only: never constructs a device engine or accesses a serial port.
import {PROFILES} from './catalog.js';
import {COMMON,hex,hexWord,xor,checkFrame,displayValue,signed,validateProfile} from './protocol.js';
import {checkS21,checksumS21,S21_PROFILE,S21_COMMANDS} from './s21.js';
const names=new Map(PROFILES.map(p=>[p.saId,p.name]));
const printable=bytes=>Array.from(bytes,b=>b>=32&&b<=126?String.fromCharCode(b):`\\x${b.toString(16).padStart(2,'0')}`).join('');
const limits={bytes:65536,packets:2000,text:1000000};
const normalizeDirection=d=>['RX','TX'].includes(d)?d:'auto';
const s21Label=command=>command==='FC'?'型號代碼':S21_COMMANDS[command]||'原始／延伸命令';
const plausibleS21=bytes=>bytes[1]>=65&&bytes[1]<=90&&(bytes.length===4||bytes[2]>=48&&bytes[2]<=122);
function getProfile(id,options){return options.profile?.saId===id?options.profile:PROFILES.find(p=>p.saId===id);}
function selection(options){return Number(options.deviceId)>0?Number(options.deviceId):null;}
function serviceValue(s,raw){if(!s)return `原始整數 ${raw} / 有號 ${signed(raw)}（縮放與單位未知）`;if(raw===65535)return '無資料（FFFF）';if(s.enum&&!Object.hasOwn(s.enum,String(raw)))return `未定義列舉值 ${raw}`;return displayValue(s,raw);}
function byteArray(input){if(!Array.isArray(input)&&!ArrayBuffer.isView(input))throw Error('封包必須是位元組陣列');const bytes=Array.from(input);if(!bytes.length||bytes.length>limits.bytes||bytes.some(b=>!Number.isInteger(b)||b<0||b>255))throw Error('封包必須包含有效的 0–255 位元組');return bytes;}
export function decodePacket(input,options={}){
  const b=byteArray(input),direction=normalizeDirection(options.direction);
  let protocol=options.protocol||'auto';
  if(protocol==='auto')protocol=b[0]===2&&b.length>=4?'s21':b.length>=4&&b[0]===b.length?'taiseia':'unknown';
  if(!['s21','taiseia'].includes(protocol))protocol='unknown';
  const p={protocol,bytes:b,hex:hex(b),direction,summary:'',device:null,deviceId:null,fields:[],warnings:[],checksum:null};
  const warn=message=>{if(!p.warnings.includes(message))p.warnings.push(message);};
  const field=(offset,length,label,value)=>{const data=b.slice(offset,Math.min(b.length,offset+length));if(data.length)p.fields.push({offset,length:data.length,label,raw:hex(data),value:String(value??'')});};
  if(protocol==='unknown'){
    p.summary=b.length===1&&[6,21].includes(b[0])?`可能是 S21 ${b[0]===6?'ACK':'NAK'}，也可能是 TaiSEIA 未完成的長度欄位`:'無法確定封包格式／殘包';
    warn('請補完整封包、前後收發資料，或手動指定協議。');field(0,b.length,'原始資料',printable(b));
  }else if(protocol==='s21')decodeS21Packet(b,options,p,field,warn);
  else decodeTaiPacket(b,options,p,field,warn);
  if(p.checksum?.valid===false)warn('校驗失敗：以下僅按欄位位置解讀，不代表有效命令，也不會修補或執行。');
  p.status=protocol==='unknown'?'unknown':p.checksum?.valid===false?'error':p.warnings.length?'warning':'valid';
  return p;
}
function decodeTaiPacket(b,options,p,field,warn){
  p.checksum={algorithm:'XOR',valid:checkFrame(b),expected:xor(b.slice(0,-1)),actual:b.at(-1)};
  field(0,1,'LEN',`${b[0]} bytes（實際 ${b.length}）`);
  if(b.length<4||b[0]!==b.length){p.summary='TaiSEIA 長度不符／未完成封包';warn('LEN 必須等於包含校驗碼的總位元組數。');field(1,b.length-1,'殘留資料',printable(b.slice(1)));return;}
  const common=b[1]===0,request=options.requestBytes;
  const bare=options.format==='bare-services'||(request?.[1]===0&&request?.[2]===7&&p.direction!=='RX'&&(b.length-2)%3===0&&(b.length-4)%3!==0);
  let id=bare||common?selection(options):b[1],profile=getProfile(id,options);
  function choose(value){id=value;profile=getProfile(value,options);p.deviceId=value;p.device=names.get(value)||`未知設備 0x${hexWord(value)}`;}
  if(id)choose(id);
  function tuples(start,capabilities){
    const length=b.length-1-start;
    if(length%3){warn('功能清單資料長度不是 3 的倍數；保留尾端未完成資料。');}
    if(!profile)warn('共通回覆不含設備類型；功能名稱、縮放與單位需要選型或前面的註冊／SA Type 回覆。');
    for(let i=start;i+2<b.length-1;i+=3){
      const sid=capabilities?b[i]&127:b[i],raw=(b[i+1]<<8)|b[i+2],s=profile?.services.find(s=>s.id===sid);
      const name=s?.name||`未知功能 0x${hex([sid])}`;
      field(i,1,capabilities?'功能 ID / bit7 存取':'功能 ID',`${name}${capabilities?b[i]&128?' · 可寫入 R/W':' · 唯讀 R':''}`);
      field(i+1,2,capabilities?'能力原始值':'數值',capabilities?`0x${hexWord(raw)}；${s?.capability===raw?s.capabilityBasis:'編碼依機型，未套用通用範圍公式'}`:serviceValue(s,raw));
    }
    if(length%3)field(b.length-1-length%3,length%3,'未完成功能資料','不足一組 ID + HI + LO');
    return Math.floor(length/3);
  }
  if(bare){
    p.summary=`TaiSEIA 精簡服務清單 · ${tuples(1,true)} 項`;
    if((b.length-2)%3)warn('所選精簡格式不符：LEN + N × 3 bytes + XOR。');
    if(b.length<6)warn('此短精簡清單可拆解，但部分 TaiXia 控制器有最小接收長度限制。');
  }else{
    field(1,1,'SA',common?'00 共通命名空間':p.device||`未知 SA ${b[1]}`);
    // Registration has two terminated strings and complete trailing triplets.
    const brandEnd=b.indexOf(0,8),modelEnd=brandEnd>=8?b.indexOf(0,brandEnd+1):-1;
    const registrationCandidate=common&&b.length>=12&&brandEnd>8&&modelEnd>brandEnd+1&&modelEnd<b.length-1&&b.slice(8,brandEnd).every(v=>v>=32&&v<=126)&&b.slice(brandEnd+1,modelEnd).every(v=>v>=32&&v<=126);
    const alsoList=common&&[7,8].includes(b[2])&&(b.length-4)%3===0;
    const registration=registrationCandidate&&(!alsoList||options.format==='registration'||request?.[1]===0&&request?.[2]===0);
    if(registrationCandidate&&alsoList&&!registration)warn('同時符合清單與註冊字串形狀；先按標準清單轉譯，不以字串形狀推斷設備。可指定「註冊回覆」格式或提供前一筆註冊查詢。');
    const commonQuery=common&&b.length===6&&b[3]===255&&b[4]===255&&Object.hasOwn(COMMON,b[2]);
    if(commonQuery&&p.direction!=='TX'){
      field(2,1,'SERVICE',COMMON[b[2]]);field(3,2,'查詢值','FFFF');p.summary=`TaiSEIA 查詢 ${COMMON[b[2]]}`;
      if(p.direction==='auto'){warn('按格式推定為共通查詢；若這是设备回覆，請指定 TX 重新解讀。');}
    }else if(registration){
      choose((b[6]<<8)|b[7]);
      field(2,1,'Class / 原始旗標',`Class ${b[2]&15}；原始 0x${hex([b[2]])}`);
      field(3,2,'版本',`${b[3]}.${b[4]}`);field(5,1,'註冊 byte 5',`原始 0x${hex([b[5]])}；不據此推斷設備種類`);
      field(6,2,'SA Type',`${p.device} · 0x${hexWord(p.deviceId)}`);
      field(8,brandEnd-8+1,'品牌（NUL 結尾）',printable(b.slice(8,brandEnd)));
      field(brandEnd+1,modelEnd-brandEnd,'型號（NUL 結尾）',printable(b.slice(brandEnd+1,modelEnd)));
      p.summary=`TaiSEIA 註冊回覆 · ${p.device} · ${printable(b.slice(8,brandEnd))} ${printable(b.slice(brandEnd+1,modelEnd))}`;
      if(b[2]&128){field(modelEnd+1,b.length-modelEnd-2,'擴充功能資料','資料型態 bit7=1；保留原始值');warn('資料型態 bit7=1，未套用一般三位元組服務表。');}
      else p.summary+=` · ${tuples(modelEnd+1,true)} 項功能`;
      if(p.direction==='RX')warn('內容符合設備註冊回覆，但方向標為 RX；本工具 RX 定義為控制器 → 設備。');
    }else if(common){
      const sid=b[2],data=b.slice(3,-1);field(2,1,'SERVICE',COMMON[sid]||`未知共通功能 ${sid}`);
      if(sid===7||sid===8){p.summary=`TaiSEIA ${sid===7?'服務能力清單':'完整狀態回覆'} · ${tuples(3,sid===7)} 項`;
        if(p.direction==='RX')warn('按清單格式解讀；方向 RX 與設備回覆格式不一致。');
      }else if([1,2,4].includes(sid)&&data.length===2){
        const raw=(data[0]<<8)|data[1];
        if(sid===4)choose(raw);
        const value=sid===2?`${data[0]}.${data[1]}`:sid===4?`${p.device} · 0x${hexWord(raw)}`:`${raw}`;
        field(3,2,COMMON[sid],value);p.summary=`TaiSEIA ${COMMON[sid]} 回覆 · ${value}`;
        if(p.direction==='RX')warn('RX 共通讀取請求應為 FFFF；這裡按回覆欄位解讀。');
      }else if([5,6].includes(sid)){
        const nul=data.indexOf(0),text=nul>=0?data.slice(0,nul):data;
        field(3,data.length,COMMON[sid],printable(text));p.summary=`TaiSEIA ${COMMON[sid]}回覆 · ${printable(text)}`;
        if(nul<0||nul!==data.length-1)warn('品牌／型號缺少結尾 NUL，或 NUL 後仍有資料。');
      }else {p.summary=`TaiSEIA ${COMMON[sid]||'未知共通功能'} · 原始資料`;field(3,data.length,'DATA',printable(data));warn('此共通回覆結構或功能尚未辨識。');}
    }else{
      const command=b[2],sid=command&127,write=Boolean(command&128),s=profile?.services.find(s=>s.id===sid);
      field(2,1,'SERVICE',command===255?'FF 錯誤回覆':`${s?.name||'未知功能'} · ID 0x${hex([sid])} · bit7=${write?1:0}`);
      if(b.length!==6){p.summary='TaiSEIA 非標準單功能封包';field(3,b.length-4,'DATA',printable(b.slice(3,-1)));warn('一般單功能封包應為 6 bytes。');}
      else{
        const raw=(b[3]<<8)|b[4],value=serviceValue(s,raw),name=s?.name||`功能 0x${hex([sid])}`;
        field(3,2,'DATA HI / LO',raw===65535&&p.direction==='RX'&&!write?'FFFF 查詢值':value);
        if(command===255){p.summary='TaiSEIA Service FF · 錯誤回覆';warn('FF 的資料意義依機型／原請求，不解作功能值。');}
        else if(write){
          p.summary=`TaiSEIA ${p.device||'未知設備'} · ${name} ${value} · ${p.direction==='RX'?'寫入命令':p.direction==='TX'?'寫入回覆（echo）':'寫入命令／echo 回覆待分辨'}`;
          if(p.direction==='auto')warn('寫入命令與成功 echo 回覆可以完全相同；需 RX/TX 或配對請求。');
          if(raw===65535)warn('FFFF 不是此功能表中的可設定數值。');
        }else if(p.direction==='RX'){
          p.summary=`TaiSEIA 讀取 ${p.device||'未知設備'} · ${name}`;if(raw!==65535)warn('讀取請求資料不是 FFFF，請檢查方向或命令內容。');
        }else if(p.direction==='auto'&&raw===65535){p.summary=`TaiSEIA ${name} · 讀取請求／FFFF 無資料回覆待分辨`;warn('FFFF 可代表請求的查詢值，也可代表回覆無資料；請指定方向。');}
        else {p.summary=`TaiSEIA ${p.device||'未知設備'} · ${name}回覆：${value}`;if(p.direction==='auto')warn('依未設定寫入 bit 且含數值推定為回覆；請核對收發方向。');}
        if(!s&&command!==255)warn('此 SA／功能 ID 沒有對應功能表；保留原始值，不猜測物理單位。');
        if(s&&raw!==65535&&s.enum&&!Object.hasOwn(s.enum,String(raw)))warn('列舉值未在此參考功能表定義；可能是機型差異。');
      }
    }
  }
  field(b.length-1,1,'XOR',`收到 ${hex([p.checksum.actual])}；計算 ${hex([p.checksum.expected])}`);
}
function decodeS21Packet(b,options,p,field,warn){
  p.device='Daikin S21 空調族';p.deviceId='s21';
  if(b.length===1&&[6,21].includes(b[0])){p.summary=`S21 ${b[0]===6?'ACK 確認':'NAK 拒絕'}`;field(0,1,b[0]===6?'ACK':'NAK','控制字元，沒有 checksum');warn('單一 ACK/NAK 無命令識別碼；須配對前後收發資料，不能單獨證明握手完成。');return;}
  p.checksum={algorithm:'SUM8（02/03/06/15 加 2）',valid:checkS21(b),expected:checksumS21(b.slice(1,-2)),actual:b.at(-2)};
  if(b.length<4||b[0]!==2||b.at(-1)!==3){p.summary='S21 框架不完整';field(0,b.length,'原始資料',printable(b));warn('S21 需要 STX、命令、SUM 與 ETX。');return;}
  let count=b[1]===77||b[1]===86?1:2;
  if(printable(b.slice(1,7))==='VS000M')count=6;
  else if('FDGRS'.includes(String.fromCharCode(b[1]))&&'UXY'.includes(String.fromCharCode(b[2]))&&b.length>=7&&b.slice(3,5).every(n=>n>=48&&n<=57||n>=65&&n<=90))count=4;
  const cmd=String.fromCharCode(...b.slice(1,1+count)),data=b.slice(1+count,-2),start=1+count;
  const response=['G','S'].includes(cmd[0]),request=['D','F','R'].includes(cmd[0]),query=response?String.fromCharCode(cmd.charCodeAt(0)-1)+cmd.slice(1):cmd;
  field(0,1,'STX','02 起始');field(1,count,'命令',`${cmd} · ${s21Label(query)}`);
  if(response&&p.direction==='RX'||request&&p.direction==='TX')warn('命令角色與所選方向不符；此處 RX=控制器→設備，TX=設備→控制器。');
  p.summary=`S21 ${cmd} · ${s21Label(query)}`;
  let interpreted=false;
  function expected(length){if(data.length===length)return true;warn(`${cmd} 資料長度應為 ${length} bytes，實際 ${data.length}；未套用數值公式。`);return false;}
  function value(index,length,label,text){field(start+index,length,label,text);}
  const mode=S21_PROFILE.services.find(s=>s.id===1).enum,fan=S21_PROFILE.services.find(s=>s.id===2).enum;
  if(cmd.length===2&&['F','R'].includes(cmd[0])){interpreted=true;p.summary+= ' · 控制器查詢';if(data.length)warn('此 v2 查詢通常不含 payload；額外資料保留原樣。');if(!Object.hasOwn(S21_COMMANDS,query))warn('可辨識查詢格式；功能旗標或機型語意未在此轉譯表完整定義。');}
  else if(['D1','G1'].includes(cmd)&&expected(4)){
    interpreted=true;const power=data[0]===48?'關機':data[0]===49?'開機':`未知電源 ${hex([data[0]])}`,m=mode[data[1]-48]||`未知模式 ${hex([data[1]])}`,f=fan[data[3]]||`未知風速 ${hex([data[3]])}`,t=(data[2]-28)/2;
    value(0,1,'電源',power);value(1,1,'模式',m);value(2,1,'設定溫度',`${t} °C = (0x${hex([data[2]])} − 28) / 2`);value(3,1,'風速',f);
    p.summary=`S21 ${cmd} · ${power}／${m}／${t} °C／風速 ${f}`;
    if(![48,49].includes(data[0])||!mode[data[1]-48]||!fan[data[3]])warn('含未定義電源、模式或風速列舉值。');
    if(t<10||t>32)warn('設定溫度超出本模擬設定的 10–32°C；實機範圍需另校對。');
  }else if(['D5','G5'].includes(cmd)&&expected(4)){
    interpreted=true;const swing={48:'停止',49:'上下',50:'左右',55:'上下＋左右'}[data[0]]||`未知擺風 ${hex([data[0]])}`;value(0,1,'擺風',swing);value(1,3,'其他機型欄位','原始資料；含加濕／保留欄位，不通用推斷');p.summary+=` · ${swing}`;if(![48,49,50,55].includes(data[0]))warn('擺風列舉值未收錄，請依機型校對。');
  }else if(['D6','G6'].includes(cmd)&&expected(4)){
    interpreted=true;const on=(index,mask)=>data[index]&mask?'開':'關';
    value(0,1,'特殊模式旗標',`強力 ${on(0,2)}／舒適 ${on(0,64)}／室外靜音 ${on(0,128)}`);value(1,1,'Streamer',on(1,128));value(2,1,'保留欄位','原始值');value(3,1,'感測／指示燈旗標',`人體感測 ${on(3,8)}／指示燈位元 ${on(3,4)}`);p.summary+=` · 強力${on(0,2)}／舒適${on(0,64)}／室外靜音${on(0,128)}`;
  }else if(['D7','G7'].includes(cmd)&&expected(4)){
    interpreted=true;value(0,1,'需求節能量',`${data[0]-48}%（不是剩餘功率上限）`);value(1,1,'節能模式',data[1]===50?'開':data[1]===48?'關':`未知 ${hex([data[1]])}`);value(2,2,'保留欄位','原始值');p.summary+=` · 需求節能量 ${data[0]-48}%`;
    if(data[0]<48||data[0]>148||![48,50].includes(data[1]))warn('需求／節能欄位超出已知編碼。');
  }else if(cmd==='G8'&&expected(4)){
    interpreted=true;value(0,4,'舊式版本欄位',data[1]>=48&&data[1]<=57?`版本值 ${data[1]-48}；完整原始值 ${hex(data)}`:`未知版本值 ${hex(data)}`);warn('較新 S21 也可能在 F8 回報 2；不能只靠 G8 排除 v3。');
  }else if(cmd==='G9'&&expected(4)){
    interpreted=true;const temp=v=>v===255?'無資料（FF）':`${(v-128)/2} °C`;
    value(0,1,'室內溫度',temp(data[0]));value(1,1,'室外溫度',temp(data[1]));value(2,2,'機型／保留欄位','原始值');p.summary+=` · 室內 ${temp(data[0])}／室外 ${temp(data[1])}`;
  }else if(cmd==='GC'&&expected(4)){
    interpreted=true;const model=printable(data.slice().reverse());value(0,4,'型號代碼（倒序 ASCII）',model);p.summary+=` · ${model}`;
  }else if(cmd==='GM'&&expected(4)){
    const text=String.fromCharCode(...data.slice().reverse());if(/^[0-9A-Fa-f]{4}$/.test(text)){interpreted=true;const kwh=Number((parseInt(text,16)*.1).toFixed(1));value(0,4,'累積耗電',`0x${text} × 0.1 = ${kwh} kWh`);p.summary+=` · ${kwh} kWh`;}else warn('耗電欄位不是倒序 ASCII 十六進位數字。');
  }else if(['SH','SI','Sa'].includes(cmd)&&expected(4)){
    if(data.slice(0,3).every(n=>n>=48&&n<=57)&&[43,45].includes(data[3])){interpreted=true;const n=Number(String.fromCharCode(...data.slice(0,3).reverse()))*(data[3]===45?-1:1)/10;value(0,3,'溫度（倒序十進位 0.1°C）',`${n} °C`);value(3,1,'正負號',String.fromCharCode(data[3]));p.summary+=` · ${n} °C`;}else warn('溫度欄位需為三個倒序數字與 +／− ASCII 符號。');
  }else if(['SL','Sd','Se'].includes(cmd)&&expected(3)){
    if(data.every(n=>n>=48&&n<=57)){interpreted=true;const n=Number(String.fromCharCode(...data.slice().reverse()))*(cmd==='SL'?10:1),unit=cmd==='SL'?'RPM':cmd==='Sd'?'Hz':'%';value(0,3,'倒序數值',`${n} ${unit}`);p.summary+=` · ${n} ${unit}`;}else warn('數值需為三個倒序 ASCII 十進位數字。');
  }
  if(!interpreted&&data.length)field(start,data.length,'未解碼 DATA',`${hex(data)} · ASCII ${printable(data)}`);
  else if(interpreted&&['F','R'].includes(cmd[0])&&data.length)field(start,data.length,'額外 DATA',printable(data));
  if(!interpreted)warn('此命令或資料结构未提供完整轉譯；保留原始資料，不推定未知功能。');
  field(b.length-2,1,'SUM',`收到 ${hex([p.checksum.actual])}；計算 ${hex([p.checksum.expected])}`);field(b.length-1,1,'ETX','03 結束');
}
function parseHexLine(text,line){
  const clean=text.replace(/0x/gi,'').replace(/[\s,:-]/g,'');
  if(!clean||clean.length%2||!/^[0-9a-f]+$/i.test(clean))throw Error(`第 ${line} 行不是完整 HEX。可用空白、冒號、逗號分隔；收發行請使用 RX: 或 TX: 前綴。`);
  return clean.match(/../g).map(s=>parseInt(s,16));
}
function splitStream(bytes,options,context){
  const packets=[];let cursor=0;
  function s21End(at){if(bytes[at]!==2)return -1;for(let i=at+3;i<Math.min(bytes.length,at+131);i++)if(bytes[i]===3)return i;return -1;}
  function validStart(at){const n=bytes[at];if(options.protocol!=='s21'&&n>=4&&at+n<=bytes.length&&checkFrame(bytes.slice(at,at+n)))return true;const end=s21End(at),candidate=bytes.slice(at,end+1);return options.protocol!=='taiseia'&&end>=0&&end-at<131&&plausibleS21(candidate)&&checkS21(candidate);}
  while(cursor<bytes.length){
    if(packets.length>=limits.packets)throw Error('封包超過 2000 筆，請分批轉譯。');
    const rest=bytes.length-cursor,first=bytes[cursor],mode=options.protocol||'auto',end=s21End(cursor),nested=bytes.indexOf(2,cursor+1);
    let length=0,protocol='unknown';
    const taiValid=first>=4&&first<=rest&&checkFrame(bytes.slice(cursor,cursor+first));
    if(mode!=='taiseia'&&end>=0&&end-cursor<131&&plausibleS21(bytes.slice(cursor,end+1))&&checkS21(bytes.slice(cursor,end+1))){length=end-cursor+1;protocol='s21';}
    else if(mode!=='s21'&&taiValid){length=first;protocol='taiseia';}
    else if(mode!=='taiseia'&&[6,21].includes(first)&&(mode==='s21'||context.protocol==='s21')){length=1;protocol='s21';}
    else if(mode!=='taiseia'&&first===2&&nested>cursor&&(end<0||nested<end)&&validStart(nested)){length=nested-cursor;protocol=mode==='s21'?'s21':'unknown';}
    else if(mode!=='taiseia'&&first===2&&end>=0&&end-cursor<131){length=end-cursor+1;protocol='s21';}
    else if(mode!=='s21'&&first>=4&&first<=rest&&(mode==='taiseia'||[0,...names.keys()].includes(bytes[cursor+1])||options.format==='bare-services')){length=first;protocol='taiseia';}
    else{
      let next=cursor+1;while(next<bytes.length&&!validStart(next))next++;
      length=next-cursor;protocol=mode==='auto'?'unknown':mode;
      if(mode==='auto'&&first>=4&&first>rest&&[0,...names.keys()].includes(bytes[cursor+1]))protocol='taiseia';
    }
    if(length>1&&protocol!=='unknown'&&!(protocol==='s21'?checkS21(bytes.slice(cursor,cursor+length)):checkFrame(bytes.slice(cursor,cursor+length)))){
      for(let i=cursor+1;i<cursor+length;i++)if(validStart(i)){length=i-cursor;break;}
    }
    const packet=decodePacket(bytes.slice(cursor,cursor+length),{...options,protocol,deviceId:selection(options)||context.deviceId||'auto',requestBytes:context.request});
    packet.offset=cursor;packets.push(packet);
    if(packet.checksum?.valid){context.protocol=protocol;if(packet.deviceId&&packet.deviceId!=='s21')context.deviceId=packet.deviceId;
      if(protocol==='taiseia'&&length===6&&packet.bytes[1]===0&&packet.bytes[3]===255&&packet.bytes[4]===255&&packet.direction!=='TX')context.request=packet.bytes;else context.request=null;
    }else if(protocol!=='s21'||length!==1)context.request=null;
    cursor+=length;
  }
  return packets;
}
export function translateText(text,options={}){
  if(typeof text!=='string'||!text.trim())throw Error('請貼上封包 HEX 或載入擷取 JSON。');
  if(text.length>limits.text)throw Error('文字超過 1MB，請分批轉譯。');
  if(/^[\s]*[\[{]/.test(text)&&!/^\s*\[[0-9: .TZ+-]+\]\s*(RX|TX)/i.test(text)){
    try{return translateCapture(JSON.parse(text),options);}catch(e){if(e instanceof SyntaxError)throw Error('JSON 格式無法解析。');throw e;}
  }
  const groups=[];let count=0;
  text.split(/\r?\n/).forEach((original,index)=>{
    let line=original.replace(/#.*/,'').trim();if(!line)return;
    let direction=normalizeDirection(options.direction);
    const prefix=line.match(/^(?:(?:\[[^\]]+\]|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*)?(RX|TX)\s*[:>\-]?\s*/i);
    if(prefix){direction=prefix[1].toUpperCase();line=line.slice(prefix[0].length);}
    const bytes=parseHexLine(line,index+1);count+=bytes.length;if(count>limits.bytes)throw Error('單次最多 64KB 封包資料。');
    const group=groups.at(-1);if(group&&group.direction===direction){group.bytes.push(...bytes);group.lines.push(...bytes.map(()=>index+1));}else groups.push({direction,line:index+1,bytes,lines:bytes.map(()=>index+1)});
  });
  if(!groups.length)throw Error('沒有可轉譯的 HEX 資料。');
  const context={deviceId:selection(options),protocol:null,request:null},packets=[];
  for(const group of groups){for(const p of splitStream(group.bytes,{...options,direction:group.direction},context)){p.line=group.lines[p.offset]||group.line;p.index=packets.length+1;packets.push(p);if(packets.length>limits.packets)throw Error('封包超過 2000 筆，請分批轉譯。');}}
  return {packets,warnings:[],source:'text'};
}
export function translateCapture(capture,options={}){
  if(!capture||!Array.isArray(capture.records)||capture.records.length>10000)throw Error('JSON 需要 records 陣列（最多 10000 筆）；請使用本工具的擷取匯出檔。');
  const records=capture.records.filter(r=>r&&r.kind==='frame'&&['RX','TX'].includes(r.direction)),warnings=[],packets=[];
  if(!records.length)throw Error('JSON 沒有完整 RX/TX frame；原始區塊請另貼 HEX，以免重複計算封包。');
  if(records.length>limits.packets)throw Error('完整封包超過 2000 筆，請分批轉譯。');
  let count=0,contextId=null,lastSource=null;const previous=new Map();
  for(const record of records){
    const bytes=byteArray(record.bytes);count+=bytes.length;if(count>limits.bytes)throw Error('單次最多轉譯 64KB 封包資料。');
    if(record.source!==lastSource){contextId=null;lastSource=record.source;}
    let profile,raw=capture.profiles?.[record.profileRevision];
    if(raw?.protocol!=='s21'&&raw){try{profile=validateProfile(structuredClone(raw));}catch{if(!warnings.length)warnings.push('部分設定快照未通過驗證，使用內建功能表。');}}
    const optionsForPacket={...options,profile,protocol:['taiseia','s21'].includes(record.protocol)?record.protocol:options.protocol||'auto',direction:record.direction,deviceId:selection(options)||profile?.saId||contextId||'auto',format:record.format==='bare-services'?'bare-services':options.format,requestBytes:previous.get(record.requestId)};
    const p=decodePacket(bytes,optionsForPacket);p.index=packets.length+1;p.recordId=record.id;p.source=String(record.source||'匯入').slice(0,100);p.timestamp=String(record.timestamp||'').slice(0,100);packets.push(p);
    if(p.checksum?.valid){if(p.deviceId&&p.deviceId!=='s21')contextId=p.deviceId;if(record.direction==='RX'&&bytes.length===6&&bytes[1]===0&&bytes[3]===255&&bytes[4]===255)previous.set(record.id,bytes);}
  }
  return {packets,warnings,source:'capture',skipped:capture.records.length-records.length};
}
export function translationText(result){return result.packets.map(p=>[
  `#${p.index||1} ${p.protocol} ${p.direction==='auto'?'方向未指定':p.direction} · ${p.summary}`,
  p.hex,...p.fields.map(f=>`[${f.offset}${f.length>1?'..'+(f.offset+f.length-1):''}] ${f.label}: ${f.raw} → ${f.value}`),...p.warnings.map(w=>'注意：'+w)
].join('\n')).join('\n\n');}
