// Independently implemented device side of CN105 heat-pump profile 0x30.
// Evidence and deliberately unsupported model extensions: docs/cn105.md.
import {hex,signed} from './protocol.js';
export const CN105_TYPES={65:'SET 寫入',66:'GET 查詢',90:'CONNECT 連線',91:'安裝模式連線（未模擬）',97:'SET ACK 寫入確認',98:'DATA 狀態回覆',122:'CONNECT ACK 連線回覆',123:'安裝模式回覆'};
export const CN105_QUERIES={2:'設備設定',3:'室內外溫度／運轉時間',4:'故障狀態',6:'運轉狀態／功率／耗電',9:'運轉子狀態',66:'淨化／夜間／循環模式'};
export const CN105_ENUMS={power:{0:'關',1:'開'},mode:{1:'暖房',2:'除濕',3:'冷房',7:'送風',8:'自動'},fan:{0:'自動',1:'靜音',2:'1',3:'2',5:'3',6:'4'},vane:{0:'自動',1:'最上',2:'上',3:'中',4:'下',5:'最下',7:'擺動'},wide:{1:'最左',2:'左',3:'中',4:'右',5:'最右',8:'左右分流',12:'擺動'}};
export const checksumCN105=bytes=>(0xfc-Array.from(bytes).reduce((sum,b)=>sum+b,0))&255;
export function frameCN105(type,data=[]){
  const payload=Array.from(data);
  if(!Number.isInteger(type)||type<0||type>255||payload.length>64||payload.some(b=>!Number.isInteger(b)||b<0||b>255))throw Error('CN105 type／payload 不合法');
  const b=[0xfc,type,1,0x30,payload.length,...payload];return Uint8Array.from([...b,checksumCN105(b)]);
}
export function checkCN105(b){return b.length>=6&&b.length<=70&&b[0]===0xfc&&b[2]===1&&b[3]===0x30&&b[4]<=64&&b.length===b[4]+6&&checksumCN105(b.slice(0,-1))===b.at(-1);}
export function isCN105Request(b){return checkCN105(b)&&([0x5a,0x5b].includes(b[1])?b[4]===2&&b[5]===0xca&&b[6]===1:[0x41,0x42].includes(b[1])&&b[4]===16);}
export const connectCN105=()=>frameCN105(0x5a,[0xca,1]);
export const queryCN105=code=>frameCN105(0x42,[code,...Array(15).fill(0)]);
// Observed COM10 settings query variant. The 01 parameter has no confirmed
// semantics; use the ordinary 02 state response, not a fabricated extension.
export const isCompatibleCN105Get=d=>d.length===16&&d[0]===2&&d[1]===1&&d.slice(2).every(n=>n===0);
export const sampleSetCN105=()=>frameCN105(0x41,[1,0x1f,1,1,3,0,5,7,0,0,0,0,0,12,177,0]);
const field=(id,name,raw,min,max,extra={})=>({id,name,raw,min,max,protocol:'cn105',scale:1,unit:'',enum:null,signed:false,enabled:true,writable:false,command:'CN105',confidence:'公開 CN105 映射',rangeBasis:'模擬範圍，非所有機型的能力保證',source:'echavet/MitsubishiCN105ESPHome',...extra});
const toggle=(id,name,command,writable=false)=>field(id,name,0,0,1,{command,writable,enum:CN105_ENUMS.power});
export const CN105_PROFILE={schema:1,protocol:'cn105',saId:'cn105',name:'三菱電機空調（CN105）',brand:'Mitsubishi Electric',model:'CN105-SIM',replyDelay:0,temperatureEncoding:'half',confidence:'CN105 標準空調子集 · 依控制器解碼反向實作 · 尚未通過實機驗證',services:[
  toggle(0,'電源','SET 01 / GET 02',true),
  field(1,'模式',3,1,8,{enum:CN105_ENUMS.mode,writable:true,command:'SET 01 / GET 02'}),
  field(2,'風速',0,0,6,{enum:CN105_ENUMS.fan,writable:true,command:'SET 01 / GET 02'}),
  field(3,'設定溫度',52,32,62,{scale:.5,unit:'°C',writable:true,command:'SET 01 / GET 02'}),
  field(4,'上下風向',0,0,7,{enum:CN105_ENUMS.vane,writable:true,command:'SET 01 / GET 02'}),
  field(5,'左右風向',3,1,12,{enum:CN105_ENUMS.wide,writable:true,command:'SET 01 / GET 02'}),
  toggle(6,'i-See 感測旗標','GET 02'),
  field(20,'室內溫度',54,20,82,{scale:.5,unit:'°C',command:'GET 03'}),
  field(21,'室外溫度',60,-100,120,{scale:.5,signed:true,unit:'°C',command:'GET 03'}),
  toggle(22,'壓縮機運轉（獨立模擬值）','GET 06'),
  field(23,'壓縮機頻率',0,0,255,{unit:'Hz',command:'GET 06'}),
  field(24,'輸入功率',0,0,65535,{unit:'W',command:'GET 06'}),
  field(25,'累積耗電',0,0,65535,{unit:'kWh',scale:.1,command:'GET 06'}),
  field(26,'累積運轉分鐘',0,0,65535,{unit:'min',command:'GET 03'}),
  field(27,'運轉階段',0,0,6,{command:'GET 09',enum:{0:'待機',1:'低',2:'輕柔',3:'中',4:'中高',5:'高',6:'擴散'}}),
  field(28,'運轉子模式',0,0,16,{command:'GET 09',enum:{0:'正常',1:'暖機',2:'除霜',4:'預熱',8:'待機',16:'關機'}}),
  field(29,'自動子模式',0,0,3,{command:'GET 09',enum:{0:'未啟用',1:'自動冷房',2:'自動暖房',3:'主機'}}),
  toggle(30,'遠端室溫啟用','SET 07',true),
  field(31,'遠端室溫',50,16,126,{scale:.5,unit:'°C',writable:true,command:'SET 07'}),
  toggle(32,'空氣淨化','SET 08 / GET 42',true),toggle(33,'夜間模式','SET 08 / GET 42',true),toggle(34,'循環模式','SET 08 / GET 42',true),
  field(35,'故障碼',0,0,127,{command:'GET 04'}),field(36,'故障子碼',0,0,255,{command:'GET 04'})
]};
export function validateCN105Value(s,raw){
  if(!Number.isInteger(raw)||raw<0||raw>65535)return '數值須為有效整數';
  const n=s.signed?signed(raw):raw;
  if(n<s.min||n>s.max||s.enum&&!Object.hasOwn(s.enum,raw))return '數值超出此模擬欄位範圍';
  return null;
}
export function displayCN105Value(s,raw){return s.enum?.[raw]??`${(s.signed?signed(raw):raw)*s.scale}${s.unit?' '+s.unit:''}`;}
export function validateCN105Profile(p){
  if(!p||p.schema!==1||p.protocol!=='cn105'||p.saId!=='cn105'||!['half','legacy'].includes(p.temperatureEncoding)||!Number.isFinite(p.replyDelay)||p.replyDelay<0||p.replyDelay>2000||!Array.isArray(p.services)||p.services.length!==CN105_PROFILE.services.length)throw Error('CN105 設定格式無效');
  const clean=structuredClone(CN105_PROFILE);clean.replyDelay=p.replyDelay;clean.temperatureEncoding=p.temperatureEncoding;
  for(const s of clean.services){const matches=p.services.filter(x=>x.id===s.id);if(matches.length!==1||validateCN105Value(s,matches[0].raw))throw Error('CN105 '+s.name+' 數值無效');s.raw=matches[0].raw;}
  if(clean.temperatureEncoding==='legacy'&&clean.services.find(s=>s.id===3).raw%2)throw Error('傳統溫度編碼需要整數設定溫度');
  return clean;
}
// Parse flagged writes without mutating state. Unflagged bytes are placeholders.
export function cn105WriteValues(d){
  if(d.length!==16)throw Error('SET payload 需要 16 bytes');
  const values=[];
  if(d[0]===1){
    if(d[1]&~0x1f||d[2]&~1)throw Error('未支援的 SET 01 旗標');
    for(const [mask,offset,id] of [[1,3,0],[2,4,1],[8,6,2],[16,7,4]])if(d[1]&mask)values.push([id,d[offset]]);
    if(d[1]&4){if(d[14]===0x80)throw Error('溫度旗標開啟，但新溫度為未指定 80');if(!d[14]&&d[5]>15)throw Error('未支援的傳統溫度代碼');values.push([3,d[14]?d[14]-128:2*(31-d[5])]);}
    if(d[2]&1){if(d[13]&0x70)throw Error('未支援的左右風向高位旗標');values.push([5,d[13]&15]);}
  }else if(d[0]===7){
    if(![0,1].includes(d[1]))throw Error('遠端室溫啟用旗標無效');values.push([30,d[1]]);
    if(d[1])values.push([31,d[3]?d[3]-128:d[2]+16]);
  }else if(d[0]===8){
    if(d[1]||d[2]&~0x1c)throw Error('未支援的 SET 08 旗標（含 i-See 氣流控制）');
    for(const [mask,offset,id] of [[4,12,32],[8,13,33],[16,14,34]])if(d[2]&mask)values.push([id,d[offset]]);
  }else throw Error('未支援的 SET 子命令 0x'+hex([d[0]]));
  for(const [id,value] of values){const s=CN105_PROFILE.services.find(s=>s.id===id);if(validateCN105Value(s,value))throw Error(s.name+' 值不合法');}
  return values;
}
export class CN105Engine{
  constructor(profile=CN105_PROFILE){this.profile=validateCN105Profile(profile);}
  get services(){return this.profile.services;}
  service(id){return this.services.find(s=>s.id===id);}
  value(id){const s=this.service(id);return s.signed?signed(s.raw):s.raw;}
  handle(b){
    const reject=reason=>({accepted:false,responses:[],reason});
    if(!isCN105Request(b))return reject('CN105 非有效控制器命令／長度／標頭／校驗錯誤；不執行');
    if(b[1]===0x5b)return reject('CN105 安裝模式未模擬；等待控制器回退標準 5A 握手');
    if(b[1]===0x5a)return {accepted:true,responses:[frameCN105(0x7a,[0])],reason:'CN105 CONNECT → 7A 標準連線回覆'};
    const d=Array.from(b.slice(5,-1)),v=id=>this.value(id);
    if(b[1]===0x41){
      let values;try{values=cn105WriteValues(d);}catch(e){return reject(e.message+'；靜默拒絕，未送成功 ACK');}
      if(this.profile.temperatureEncoding==='legacy'&&values.some(([id,n])=>id===3&&n%2))return reject('傳統溫度設定不支援半度；未修改狀態');
      const changes=values.map(([id,after])=>({id,before:this.service(id).raw,after}));
      for(const c of changes)this.service(c.id).raw=c.after;
      return {accepted:true,responses:[frameCN105(0x61,Array(16).fill(0))],changes,reason:'CN105 '+decodeCN105(b)+' · 已套用並回覆 61 ACK'};
    }
    const compatibleGet=isCompatibleCN105Get(d);
    if(d.slice(1).some(n=>n!==0)&&!compatibleGet)return reject('CN105 未支援帶額外參數的 GET；不臆測回覆');
    const p=Array(16).fill(0);p[0]=d[0];
    switch(d[0]){
      case 2:p[3]=v(0);p[4]=v(1)+(v(6)?8:0);p[5]=31-Math.round(v(3)/2);p[6]=v(2);p[7]=v(4);p[10]=v(5);p[11]=this.profile.temperatureEncoding==='half'?v(3)+128:0;break;
      case 3:{const room=v(30)?v(31):v(20);p[3]=Math.max(0,Math.min(31,Math.round(room/2)-10));p[5]=v(21)+128;p[6]=room+128;const minutes=v(26);p[11]=(minutes>>>16)&255;p[12]=(minutes>>>8)&255;p[13]=minutes&255;break;}
      case 4:p[4]=0x80|v(35);p[5]=v(36);break;
      case 6:p[3]=v(23);p[4]=v(22);p[5]=v(24)>>8;p[6]=v(24)&255;p[7]=v(25)>>8;p[8]=v(25)&255;break;
      case 9:p[3]=v(28);p[4]=v(27);p[5]=v(29);break;
      case 0x42:p[1]=v(32);p[2]=v(33);p[3]=v(34);break;
      default:return reject('CN105 GET '+hex([d[0]])+' 未模擬；不回覆虛構狀態');
    }
    return {accepted:true,responses:[frameCN105(0x62,p)],reason:'CN105 查詢 '+CN105_QUERIES[d[0]]+(compatibleGet?' · 相容參數 01（語意未確認）；回覆標準 02 狀態':'')};
  }
}
export function decodeCN105(b){return inspectCN105(b).summary;}
// Shared passive field decoder for capture detail and text/JSON translation.
export function inspectCN105(b){
  const fields=[],warnings=[];const f=(offset,length,label,value)=>fields.push({offset,length,raw:hex(b.slice(offset,offset+length)),label,value:String(value)});
  const valid=checkCN105(b),type=b[1],d=Array.from(b.slice(5,-1));
  let summary='CN105 '+(CN105_TYPES[type]||'未知類型 0x'+hex([type??0]));
  f(0,1,'起始碼','FC');if(b.length>1)f(1,1,'TYPE',CN105_TYPES[type]||'未知類型');if(b.length>=4)f(2,2,'標頭／設備族',b[2]===1&&b[3]===0x30?'01 30 · 三菱電機空調族；不含型號':'非支援的 01 30 空調標頭');if(b.length>=5)f(4,1,'LEN',`${b[4]} payload bytes；實際總長 ${b.length}`);
  if(!valid)warnings.push('框架、標頭、長度或 checksum 不符；只顯示原始資料');
  const sf=(offset,id,raw)=>{const s=CN105_PROFILE.services.find(s=>s.id===id),invalid=validateCN105Value(s,raw&65535);f(5+offset,1,s.name,invalid?'未定義原始值 '+raw:displayCN105Value(s,raw&65535));if(invalid)warnings.push(s.name+' 超出參考映射；需依機型確認');};
  if(valid&&[0x5a,0x5b].includes(type)){f(5,d.length,'連線資料',hex(d));if(!isCN105Request(b))warnings.push('非預期的 CA 01 連線請求');}
  else if(valid&&[0x7a,0x7b,0x61].includes(type)){f(5,d.length,'回覆資料',hex(d));warnings.push(type===0x61?'寫入 ACK 不含原命令識別碼，需依前後順序配對':'連線回覆已出現；仍需後續控制器查詢確認流程');}
  else if(valid&&type===0x42&&d.length===16){summary+=' · '+(CN105_QUERIES[d[0]]||'未支援查詢 '+hex([d[0]]));f(5,1,'查詢代碼',CN105_QUERIES[d[0]]||'未知');f(6,15,'查詢保留資料',hex(d.slice(1)));if(isCompatibleCN105Get(d)){summary+=' · 相容參數 01';warnings.push('現場相容查詢：參數 01 語意未確認，回覆標準 02 狀態；未推定額外功能');}else if(!CN105_QUERIES[d[0]]||d.slice(1).some(n=>n))warnings.push('本模擬器尚未支援此查詢或參數');}
  else if(valid&&type===0x41&&d.length===16){
    f(5,1,'SET 子命令',hex([d[0]]));f(6,2,'更新旗標／遠端室溫資料',hex(d.slice(1,3)));
    try{const values=cn105WriteValues(d);summary+=' · '+(values.map(([id,n])=>{const s=CN105_PROFILE.services.find(s=>s.id===id);return s.name+' '+displayCN105Value(s,n);}).join(' / ')||'無更新欄位');
      f(8,13,'SET payload',hex(d.slice(3)));for(const [id,n] of values){const offset=d[0]===1?({0:3,1:4,2:6,3:d[14]?14:5,4:7,5:13})[id]:d[0]===7?id===30?1:d[3]?3:2:({32:12,33:13,34:14})[id];sf(offset,id,n);}
    }catch(e){warnings.push(e.message);f(8,13,'原始 SET 資料',hex(d.slice(3)));}
  }else if(valid&&type===0x62&&d.length===16){
    summary+=' · '+(CN105_QUERIES[d[0]]||'未知資料 '+hex([d[0]]));f(5,1,'資料代碼',CN105_QUERIES[d[0]]||'未知');f(6,15,'原始 payload',hex(d.slice(1)));
    switch(d[0]){
      case 2:sf(3,0,d[3]);sf(4,1,d[4]>8?d[4]-8:d[4]);sf(4,6,Number(d[4]>8));if(d[11]===128)f(16,1,'設定溫度','80 未指定／保留原值');else sf(d[11]?11:5,3,d[11]?d[11]-128:(31-d[5])*2);sf(6,2,d[6]);sf(7,4,d[7]);sf(10,5,d[10]&15);break;
      case 3:f(8,1,'傳統室溫',d[3]+10+' °C');f(10,1,'室外溫度',d[5]>1?(d[5]-128)/2+' °C':'未提供');f(11,1,'室內溫度',d[6]?(d[6]-128)/2+' °C':d[3]+10+' °C（傳統）');f(16,3,'運轉時間',((d[11]<<16)|(d[12]<<8)|d[13])+' min');break;
      case 4:f(9,2,'故障資訊',`可用旗標 ${d[4]>>7} / code ${d[4]&127} / sub ${d[5]}`);break;
      case 6:sf(3,23,d[3]);sf(4,22,d[4]);f(10,2,'輸入功率',((d[5]<<8)|d[6])+' W（依機型）');f(12,2,'累積耗電',((d[7]<<8)|d[8])/10+' kWh（依機型）');break;
      case 9:sf(3,28,d[3]);sf(4,27,d[4]);sf(5,29,d[5]);break;
      case 0x42:sf(1,32,d[1]);sf(2,33,d[2]);sf(3,34,d[3]);break;
      default:warnings.push('未知資料代碼；保留原值，不臆測機型功能');
    }
  }else if(d.length){f(5,d.length,'原始 payload',hex(d));warnings.push('此類型或資料長度尚未支援轉譯');}
  if(type===0x5b||type===0x7b)warnings.push('安裝模式未納入設備模擬');
  if(b.length>=6)f(b.length-1,1,'CHECKSUM',`收到 ${hex([b.at(-1)])}；計算 ${hex([checksumCN105(b.slice(0,-1))])}；(FC − 前面所有 bytes 加總) & FF`);
  return {summary,fields,warnings};
}
