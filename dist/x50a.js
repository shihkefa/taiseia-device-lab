// Device-side X50A subset, independently implemented from the public controller
// mappings pinned in docs/x50a.md. UART 9600 8E1; legacy simulator also uses 8E2.
import {hex,signed} from './protocol.js?v=1.3.9';
export const X50A_COMMANDS={170:'初始化 AA',183:'室外狀態 B7',186:'型號 BA',187:'相容資料 BB',189:'溫度 BD',190:'風扇／風向 BE',202:'設定／狀態 CA',203:'風速／風向 CB'};
export const X50A_ENUMS={power:{0:'關',1:'開'},mode:{0:'送風',1:'暖房',2:'冷房',3:'自動',7:'除濕'},fan:{0:'自動',1:'1',2:'2',3:'3',4:'4',5:'5'},vane:{0:'位置 0',1:'位置 1',2:'位置 2',3:'位置 3',4:'位置 4',7:'擺動'},operation:{1:'暖房',2:'冷房',6:'其他／待機'}};
export const checksumX50A=b=>(255-Array.from(b).reduce((sum,n)=>sum+n,0))&255;
export function frameX50A(command,data=[],role=0){
  const d=Array.from(data);
  if(!Number.isInteger(command)||command<0||command>255||![0,6,18].includes(role)||d.length>249||d.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('X50A 命令／資料／角色無效');
  const b=[6,command,d.length+6,1,role,...d];return Uint8Array.from([...b,checksumX50A(b)]);
}
export const checkX50A=b=>b.length>=6&&b.length<=255&&b[0]===6&&b[2]===b.length&&b[3]===1&&checksumX50A(b.slice(0,-1))===b.at(-1);
export function isX50ARequest(b){
  if(!checkX50A(b)||b[4]!==0)return false;
  const length=b.length-6;
  return b[1]===0xaa?length===1&&b[5]===1:[0xb7,0xba,0xbb,0xbd,0xbe].includes(b[1])?length===0:b[1]===0xca?length===17:b[1]===0xcb&&length===2;
}
export const connectX50A=()=>frameX50A(0xaa,[1]);
export const queryX50A=cmd=>frameX50A(cmd,cmd===0xca?Array(17).fill(0):cmd===0xcb?[0,0]:[]);
export function sampleSetX50A(){const d=Array(17).fill(0);d[0]=3;d[1]=0x12;d[3]=24;d[4]=0x85;return frameX50A(0xca,d);}
export const sampleFanX50A=()=>frameX50A(0xcb,[2,0xbf]);
const field=(id,name,raw,min,max,extra={})=>({id,name,raw,min,max,scale:1,unit:'',enum:null,signed:false,enabled:true,writable:false,command:'X50A',confidence:'公開 X50A 映射 · 待控制器驗證',rangeBasis:'本模擬範圍，非全機型能力保證',source:'RevK Faikout / maxmacstn Daikin2MQTT',...extra});
const toggle=(id,name,raw,command,writable=false)=>field(id,name,raw,0,1,{enum:X50A_ENUMS.power,command,writable});
export const X50A_PROFILE={schema:1,protocol:'x50a',saId:'x50a',name:'Daikin 空調（X50A）',brand:'Daikin',model:'SIM-X50A',replyDelay:0,outdoorReply:'status',confidence:'X50A 公開通訊子集 · 型號為模擬代碼 · 待實體控制器驗證',services:[
  toggle(0,'電源',0,'CA',true),field(1,'模式',2,0,7,{enum:X50A_ENUMS.mode,command:'CA',writable:true}),
  field(2,'風速',0,0,5,{enum:X50A_ENUMS.fan,command:'CB / CA',writable:true}),
  field(3,'設定溫度',260,100,320,{scale:.1,unit:'°C',command:'CA / BD',writable:true}),
  field(4,'上下風向',0,0,7,{enum:X50A_ENUMS.vane,command:'CB / BE',writable:true}),
  field(5,'冷暖運轉狀態',2,1,6,{enum:X50A_ENUMS.operation,command:'CA / CB'}),
  toggle(6,'從屬狀態',0,'CA'),toggle(7,'初始化就緒',1,'AA'),
  field(20,'進風溫度',270,-600,990,{scale:.1,signed:true,unit:'°C',command:'BD[0:1]'}),
  field(21,'室溫欄位（機型差異）',270,-600,990,{scale:.1,signed:true,unit:'°C',command:'BD[2:3]'}),
  field(22,'盤管溫度',185,-600,990,{scale:.1,signed:true,unit:'°C',command:'BD[4:5]'}),
  field(23,'室外溫度',300,-600,990,{scale:.1,signed:true,unit:'°C',command:'B7[0:1]'}),
  field(24,'風扇轉速',900,0,65535,{unit:'RPM',command:'BE[2:3]'}),
  field(25,'壓縮機頻率',420,0,1999,{scale:.1,unit:'Hz',command:'B7[26:27]'}),
  toggle(26,'防凍旗標',0,'BE'),field(27,'故障原始碼',0,0,255,{command:'CA[12]'}),
  field(28,'故障子碼（原始值）',0,0,255,{command:'CA[13]'}),toggle(29,'故障有效旗標',0,'CA[14]')
]};
export function validateX50AValue(s,raw){if(!Number.isInteger(raw)||raw<0||raw>65535)return '數值須為有效整數';const n=s.signed?signed(raw):raw;return n<s.min||n>s.max||s.enum&&!Object.hasOwn(s.enum,raw)?'數值超出 X50A 模擬範圍':null;}
export const displayX50AValue=(s,raw)=>s.enum?.[raw]??`${Number(((s.signed?signed(raw):raw)*s.scale).toFixed(4))}${s.unit?' '+s.unit:''}`;
export function validateX50AProfile(p){
  if(!p||p.schema!==1||p.protocol!=='x50a'||p.saId!=='x50a'||typeof p.model!=='string'||!/^[-A-Za-z0-9]{1,18}$/.test(p.model)||!Number.isFinite(p.replyDelay)||p.replyDelay<0||p.replyDelay>2000||!['status','unsupported'].includes(p.outdoorReply)||!Array.isArray(p.services)||p.services.length!==X50A_PROFILE.services.length)throw Error('X50A 設定無效；型號須為 1–18 個英數或連字號');
  const clean=structuredClone(X50A_PROFILE);for(const key of ['model','replyDelay','outdoorReply'])clean[key]=p[key];
  for(const s of clean.services){const matches=p.services.filter(n=>n.id===s.id);if(matches.length!==1||validateX50AValue(s,matches[0].raw))throw Error('X50A '+s.name+' 數值無效');s.raw=matches[0].raw;}
  return clean;
}
// A flagged write is validated in full before any field changes. Zero is a
// query/no-update placeholder, not an instruction to turn off or reset a value.
export function x50aWriteValues(cmd,d){
  const values=[];
  if(cmd===0xca){
    if(d.length!==17)throw Error('CA 需要 17 bytes');
    if(d.some((n,i)=>![0,1,3,4].includes(i)&&n!==0))throw Error('未支援的 CA 延伸欄位；未修改狀態');
    if(d[0]){if(![2,3].includes(d[0]))throw Error('CA 電源更新旗標無效');values.push([0,d[0]&1]);}
    if(d[1]){if(!(d[1]&0x10)||!Object.hasOwn(X50A_ENUMS.mode,d[1]&15)||d[1]&0xe0)throw Error('CA 模式更新旗標無效');values.push([1,d[1]&15]);}
    if(d[3]){if((d[4]&0x80)!==0x80||(d[4]&127)>9)throw Error('CA 溫度需有更新旗標及有效十分位');values.push([3,d[3]*10+(d[4]&127)]);}else if(d[4])throw Error('CA 溫度資料不完整');
  }else if(cmd===0xcb){
    if(d.length!==2||![0,1,2,6].includes(d[0]))throw Error('CB 長度或冷暖狀態無效');
    if(d[0])values.push([5,d[0]]);
    if(d[1]&0x80)values.push([2,(d[1]>>4)&7]);else if(d[1]&0x70)throw Error('CB 風速缺少更新旗標');
    if(d[1]&8)values.push([4,d[1]&7]);else if(d[1]&7)throw Error('CB 風向缺少更新旗標');
  }else throw Error('未知 X50A 寫入命令');
  for(const [id,n] of values){if(validateX50AValue(X50A_PROFILE.services.find(s=>s.id===id),n))throw Error('X50A 欄位 '+id+' 不合法');}
  return values;
}
const BB_FIXTURE=[0xd2,0x89,0,0,0x2c,0xd2,0x11,0x7d,0xb0,0x20,0,0x10,0,0x20,0,0x10,0,5,0x0c,0x24];
const word=(out,offset,n)=>{out[offset]=n&255;out[offset+1]=(n>>8)&255;};
export class X50AEngine{
  constructor(profile=X50A_PROFILE){this.profile=validateX50AProfile(profile);}
  get services(){return this.profile.services;}
  service(id){return this.services.find(s=>s.id===id);}
  value(id){const s=this.service(id);return s.signed?signed(s.raw):s.raw;}
  handle(b){
    const reject=reason=>({accepted:false,responses:[],reason});
    if(!isX50ARequest(b))return reject('X50A 非有效控制器命令／格式／長度／校驗；不執行');
    const cmd=b[1],d=Array.from(b.slice(5,-1)),v=id=>this.value(id);let out,role=6,changes=[];
    if(cmd!==0xaa&&!v(7))return reject('X50A 模擬設備尚未就緒；等待 AA 初始化');
    if([0xca,0xcb].includes(cmd)){
      let values;try{values=x50aWriteValues(cmd,d);}catch(e){return reject(e.message);}
      changes=values.map(([id,after])=>({id,before:this.service(id).raw,after}));for(const c of changes)this.service(c.id).raw=c.after;
    }
    switch(cmd){
      case 0xaa:out=[v(7)];break;
      case 0xba:out=Array(29).fill(0);Array.from(this.profile.model,(c,i)=>out[i]=c.charCodeAt(0));out.splice(19,10,0x1c,0,0x3e,0x95,0,0x70,0x65,0,1,0);break;
      case 0xbb:out=[...BB_FIXTURE];break;
      case 0xbd:out=Array(29).fill(0);for(const [offset,id] of [[0,20],[2,21],[4,22],[6,20],[8,3],[10,20]])word(out,offset,Math.round(v(id)/10*128));break;
      case 0xbe:out=[1,2,0,0,v(4),v(4)===7?1:0,v(26),0,1];word(out,2,v(24));break;
      case 0xb7:if(this.profile.outdoorReply==='unsupported'){out=[0xb7];role=18;}else{out=Array(32).fill(0);word(out,0,Math.round(v(23)/10*128));word(out,26,v(25));}break;
      case 0xca:out=Array(17).fill(0);out[0]=v(0);out[1]=v(1);out[2]=v(5);out[3]=Math.floor(v(3)/10);out[4]=v(3)%10;out[6]=(v(2)<<4)|1;out[9]=v(6);out[12]=v(27);out[13]=v(28);out[14]=v(29);out[15]=2;break;
      case 0xcb:out=[v(5),(v(2)<<4)|1];break;
    }
    return {accepted:true,responses:[frameX50A(cmd,out,role)],changes,reason:'X50A '+X50A_COMMANDS[cmd]+(changes.length?' · 已套用並回傳狀態':' · 已回覆')};
  }
}

// Passive shared decoder: capture details and translator use the same offsets.
export function inspectX50A(b){
  const fields=[],warnings=[],d=Array.from(b.slice(5,-1)),cmd=b[1],valid=checkX50A(b),request=b[4]===0;
  const f=(offset,length,label,value)=>{const raw=b.slice(offset,Math.min(b.length,offset+length));if(raw.length)fields.push({offset,length:raw.length,raw:hex(raw),label,value:String(value)});};
  const val=(at,length,label,value)=>f(5+at,length,label,value);
  const temp=(at,label)=>{const n=signed(d[at]|d[at+1]<<8);val(at,2,label,n===0?'0 °C／來源控制器可能視為未提供':`${Number((n/128).toFixed(4))} °C（int16 LE ÷ 128）`);};
  let summary='X50A '+(X50A_COMMANDS[cmd]||'未知命令 '+hex([cmd??0]));
  f(0,1,'起始碼','06');f(1,1,'CMD',X50A_COMMANDS[cmd]||'未知命令');f(2,1,'LEN',`${b[2]} bytes（實際 ${b.length}）`);f(3,1,'格式','01');f(4,1,'角色／狀態',request?'00 控制器請求':b[4]===6?'06 設備回覆':b[4]===18?'12 未支援／特殊回覆':'未確認的角色值');
  if(!valid)warnings.push('X50A 框架、長度或校驗不符；只保留原始資料');
  if(!Object.hasOwn(X50A_COMMANDS,cmd))warnings.push('未知 X50A 命令；保留資料，不推定功能');
  if(valid){
    if(request){
      if(!isX50ARequest(b))warnings.push('此請求的資料長度或命令形式未支援');
      if([0xca,0xcb].includes(cmd)){
        try{const values=x50aWriteValues(cmd,d);if(!values.length)summary+=' · 查詢（無更新）';for(const [id,n] of values){const s=X50A_PROFILE.services.find(s=>s.id===id),at=cmd===0xca?({0:0,1:1,3:3})[id]:id===5?0:1;val(at,id===3?2:1,s.name,displayX50AValue(s,n));}if(values.length)summary+=' · '+values.map(([id,n])=>{const s=X50A_PROFILE.services.find(s=>s.id===id);return s.name+' '+displayX50AValue(s,n);}).join('／');}
        catch(e){warnings.push(e.message);}
      }else if(cmd===0xaa&&d.length===1){val(0,1,'初始化請求',d[0]===1?'01 要求就緒狀態':'未知值');}
      else if(d.length===0)summary+=' · 查詢';
    }else if(b[4]===18){val(0,d.length,'特殊回覆資料',hex(d));warnings.push('此回覆不提供正常狀態；不能據此推定控制成功');}
    else if(b[4]!==6)warnings.push('未知 X50A 角色／回覆狀態');
    else{
      const lengths={170:1,183:32,186:29,187:20,189:29,190:9,202:17,203:2};
      if(Object.hasOwn(lengths,cmd)&&d.length!==lengths[cmd])warnings.push(`此參考回覆需要 ${lengths[cmd]} bytes payload，實際 ${d.length}；未套用欄位公式`);
      else switch(cmd){
        case 0xaa:val(0,1,'初始化就緒',d[0]===1?'已就緒':d[0]===0?'尚未就緒':'未知值');warnings.push('初始化回覆後仍需控制器後續查詢，才確認握手流程');break;
        case 0xba:{const end=d.indexOf(0);val(0,end<0?d.length:end+1,'設備宣告型號',String.fromCharCode(...d.slice(0,end<0?d.length:end)));warnings.push('型號為設備宣告內容；模擬器預設 SIM-X50A，不代表辨識到真機。其餘能力資料保留原始值');break;}
        case 0xbb:warnings.push('相容資料 BB 的完整語意未公開；模擬回覆為參考樣本');break;
        case 0xbd:temp(0,'進風溫度');temp(2,'室溫欄位（機型差異）');temp(4,'盤管溫度');temp(8,'設定溫度（Q7）');break;
        case 0xbe:val(2,2,'風扇轉速',(d[2]|d[3]<<8)+' RPM');val(4,1,'上下風向',X50A_ENUMS.vane[d[4]]||'未知值 '+d[4]);val(5,1,'擺風旗標',d[5]);val(6,1,'防凍旗標',d[6]);if(!Object.hasOwn(X50A_ENUMS.vane,d[4]))warnings.push('風向列舉未收錄');break;
        case 0xb7:temp(0,'室外溫度');val(26,2,'壓縮機頻率',((d[26]|d[27]<<8)/10)+' Hz（依 Daikin2MQTT 映射）');warnings.push('B7 室外狀態依機型而異，部分設備僅回 12 未支援');break;
        case 0xca:for(const [at,id,raw] of [[0,0,d[0]],[1,1,d[1]],[2,5,d[2]],[6,2,(d[6]>>4)&7],[9,6,d[9]]]){const s=X50A_PROFILE.services.find(s=>s.id===id);val(at,1,s.name,displayX50AValue(s,raw));if(validateX50AValue(s,raw))warnings.push(s.name+' 數值未收錄');}val(3,2,'設定溫度',`${d[3]+(d[4]&127)/10} °C`);if(d[4]&128||(d[4]&127)>9)warnings.push('狀態溫度含未定義旗標或十分位');val(12,3,'故障原始資料',`code ${d[12]} / sub ${d[13]} / 有效旗標 ${d[14]}`);break;
        case 0xcb:val(0,1,'冷暖運轉狀態',X50A_ENUMS.operation[d[0]]||'未知值 '+d[0]);val(1,1,'風速',X50A_ENUMS.fan[(d[1]>>4)&7]||'未知值 '+((d[1]>>4)&7));break;
      }
    }
  }
  if(d.length)val(0,d.length,'原始 payload',hex(d));
  if(b.length>=6)f(b.length-1,1,'CHECKSUM',`收到 ${hex([b.at(-1)])}；計算 ${hex([checksumX50A(b.slice(0,-1))])}；全部 bytes 相加 & FF = FF`);
  return {summary,fields,warnings};
}
export const decodeX50A=b=>inspectX50A(b).summary;
