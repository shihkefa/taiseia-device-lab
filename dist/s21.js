// Independent S21 v2 device implementation. Evidence: asund/esphome-daikin-s21
// 30239f5 and RevK/Faikout 202b9ef (see docs/s21.md). No v3 support advertised.
import {hex, signed, validateValue, displayValue} from './protocol.js';
export const ACK=0x06, NAK=0x15;
export const ascii=text=>Array.from(text,c=>c.charCodeAt(0));
export function checksumS21(body){let sum=Array.from(body).reduce((n,b)=>(n+b)&255,0);return [2,3,6,21].includes(sum)?sum+2:sum;}
export function frameS21(command,data=[]){
  if(!/^[A-Za-z0-9]{1,6}$/.test(command))throw Error('S21 命令須為 1–6 個 ASCII 字元');
  const body=[...ascii(command),...(typeof data==='string'?ascii(data):data)];
  if(body.some(b=>!Number.isInteger(b)||b<0||b>255)||body.length>128)throw Error('S21 資料無效');
  return Uint8Array.from([2,...body,checksumS21(body),3]);
}
export function checkS21(b){return b.length>=4&&b.length<=131&&b[0]===2&&b.at(-1)===3&&checksumS21(b.slice(1,-2))===b.at(-2);}
export function commandS21(b){return [77,86].includes(b[1])?String.fromCharCode(...b.slice(1,-2)):String.fromCharCode(...b.slice(1,3));}
export function validateS21Value(s,raw){if(raw===65535&&s.signed&&s.min<=-1&&s.max>=-1)return null;if(raw===65535)return '數值超出範圍';return validateValue(s,raw,{local:true});}
export function displayS21Value(s,raw){if(raw===65535&&s.signed)return `${-s.scale}${s.unit?' '+s.unit:''}`;return displayValue(s,raw);}
export const S21_COMMANDS={F1:'電源／模式／溫度／風速',D1:'設定電源／模式／溫度／風速',F5:'擺風',D5:'設定擺風',F6:'特殊模式',D6:'設定特殊模式',F7:'節能／需求限制',D7:'設定節能／需求限制',F8:'協定版本（v2）',F9:'室內外溫度（0.5°C）',FC:'模擬型號代碼',FM:'累積耗電',RH:'室內溫度',RI:'盤管溫度',Ra:'室外溫度',RL:'風扇轉速',Rd:'壓縮機頻率',Re:'室內濕度'};
const SOURCE='asund S21 / RevK Faikout 公開程式；機型可有差異';
function field(id,name,raw,min,max,extra={}){return {id,name,raw,min,max,scale:1,enum:null,signed:false,enabled:true,writable:false,unit:'',capability:0,confidence:'公開 S21 v2 映射',rangeBasis:'模擬設定範圍，非全機型保證',source:SOURCE,capabilityBasis:'S21 無 TaiSEIA 能力值',...extra};}
const toggle=(id,name,command)=>field(id,name,0,0,1,{command,writable:true,enum:{0:'關',1:'開'}});
export const S21_PROFILE={schema:1,protocol:'s21',saId:'s21',name:'Daikin 空調（S21）',brand:'Daikin',model:'SIM1',version:[2,0],replyDelay:0,confidence:'S21 v2 模擬 · 型號為模擬代碼 · 未連接實機認證',
  // Static fixtures are explicitly labeled; these are not inferred generic capabilities.
  rawReplies:{F2:[0x3c,0x3a,0,0x80],F3:[0x30,0x30,0x30,0x30],F4:[0x30,0,0x80,0],FB:[0x30,0x30,0x30,0x30],FG:[0x30,0x30,0x30,0x30],FK:[0x30,0x32,0x35,0x31],FN:[0x30,0x30,0x30,0x30],FP:[0x31,0x35,0x30,0x30],FQ:[0x45,0x34,0x30,0x30],FR:[0x30,0x30,0x30,0x30],FS:[0x30,0x30,0x30,0x30],FT:[0x31,0x30,0x30,0x30]},
  services:[
    toggle(0,'電源','F1 / D1'),
    field(1,'模式',3,0,7,{command:'F1 / D1',writable:true,enum:{0:'自動／自動冷房（0）',1:'自動（1）',2:'除濕',3:'冷房',4:'暖房',6:'送風',7:'自動暖房（7）'}}),
    field(2,'風速',65,51,66,{command:'F1 / D1',writable:true,enum:{51:'1',52:'2',53:'3',54:'4',55:'5',65:'自動 A',66:'靜音 B'}}),
    field(3,'設定溫度',52,20,64,{command:'F1 / D1',writable:true,scale:.5,unit:'°C'}),
    field(4,'擺風',0,0,7,{command:'F5 / D5',writable:true,enum:{0:'停止',1:'上下',2:'左右',7:'上下＋左右'}}),
    toggle(6,'強力模式','F6 / D6'),toggle(7,'舒適模式','F6 / D6'),toggle(8,'室外靜音','F6 / D6'),toggle(9,'Streamer','F6 / D6'),toggle(10,'人體感測','F6 / D6'),toggle(11,'指示燈旗標','F6 / D6'),toggle(12,'節能','F7 / D7'),
    field(13,'需求節能量',0,0,100,{command:'F7 / D7',writable:true,unit:'%'}),
    field(20,'室內溫度',270,-600,600,{command:'RH / F9',signed:true,scale:.1,unit:'°C'}),
    field(21,'盤管溫度',185,-999,999,{command:'RI',signed:true,scale:.1,unit:'°C'}),
    field(22,'室外溫度',300,-600,600,{command:'Ra / F9',signed:true,scale:.1,unit:'°C'}),
    field(23,'風扇轉速',90,0,999,{command:'RL',scale:10,unit:'RPM'}),
    field(24,'壓縮機頻率',42,0,999,{command:'Rd',unit:'Hz'}),
    field(25,'室內濕度',50,0,100,{command:'Re',unit:'%'}),
    field(26,'累積耗電',2,0,65534,{command:'FM',scale:.1,unit:'kWh'})
  ]};
export function validateS21Profile(p){
  if(!p||p.schema!==1||p.protocol!=='s21'||p.saId!=='s21')throw Error('S21 設定檔格式無效');
  if(typeof p.model!=='string'||!/^[ -~]{4}$/.test(p.model))throw Error('S21 v2 型號代碼須為 4 個可列印 ASCII 字元');
  if(!Number.isFinite(p.replyDelay)||p.replyDelay<0||p.replyDelay>2000)throw Error('回覆延遲須為 0–2000 ms');
  if(!Array.isArray(p.services)||p.services.length!==S21_PROFILE.services.length)throw Error('S21 狀態欄位不完整');
  const clean=structuredClone(S21_PROFILE);clean.model=p.model;clean.replyDelay=p.replyDelay;
  for(const base of clean.services){const matches=p.services.filter(s=>s.id===base.id);if(matches.length!==1||validateS21Value(base,matches[0].raw))throw Error(`S21 ${base.name} 數值不合法`);base.raw=matches[0].raw;}
  if(!p.rawReplies||typeof p.rawReplies!=='object'||Array.isArray(p.rawReplies)||Object.keys(p.rawReplies).length>50)throw Error('S21 原始回覆表無效');
  clean.rawReplies={};for(const [cmd,payload] of Object.entries(p.rawReplies)){
    if(!/^[FR][A-Za-z0-9]$/.test(cmd)||Object.hasOwn(S21_COMMANDS,cmd))throw Error('原始回覆僅支援未內建的兩字元 F/R 查詢');
    if(!Array.isArray(payload)||!payload.length||payload.length>64||payload.some(b=>!Number.isInteger(b)||b<0||b>255||b===2||b===3))throw Error('原始資料須為 1–64 bytes，不能含 STX/ETX');
    clean.rawReplies[cmd]=[...payload];
  }
  return clean;
}
const reverseNumber=(n,width)=>ascii(String(Math.abs(n)).padStart(width,'0').split('').reverse().join(''));
const temperature=n=>[...reverseNumber(n,3),n<0?45:43];
export class S21Engine {
  constructor(profile=S21_PROFILE){this.profile=validateS21Profile(structuredClone(profile));}
  get services(){return this.profile.services;}
  service(id){return this.profile.services.find(s=>s.id===id);}
  value(id){const s=this.service(id);return s.signed?signed(s.raw):s.raw;}
  reject(reason){return {accepted:false,responses:[Uint8Array.of(NAK)],reason};}
  handle(b){
    if(!checkS21(b))return {accepted:false,responses:[],reason:'S21 checksum／框架不符；不執行'};
    const cmd=commandS21(b),data=Array.from(b.slice(3,-2));
    if(['M','V','VS000M'].includes(cmd))return this.reject(`${cmd} 未支援；本設定為 S21 v2 子集`);
    if(cmd[0]==='D'){
      if(data.length!==4)return this.reject(`${cmd} 資料長度錯誤（需要 4 bytes）`);
      let values;
      if(cmd==='D1')values=[[0,data[0]-48],[1,data[1]-48],[3,data[2]-28],[2,data[3]]];
      else if(cmd==='D5'){
        if(![0x30,0x3f].includes(data[1])||data[2]!==0x30||![0x30,0x80].includes(data[3]))return this.reject('D5 尚未支援加濕／擺風保留位元組設定');
        values=[[4,data[0]-48]];
      }
      else if(cmd==='D6'){
        if((data[0]&0x3d)!==0x30||(data[1]&0x7f)!==0x30||data[2]!==0x30||(data[3]&0xf3)!==0x30)return this.reject('D6 未支援的旗標');
        values=[[6,Number(Boolean(data[0]&2))],[7,Number(Boolean(data[0]&64))],[8,Number(Boolean(data[0]&128))],[9,Number(Boolean(data[1]&128))],[10,Number(Boolean(data[3]&8))],[11,Number(Boolean(data[3]&4))]];
      }
      else if(cmd==='D7'){
        if(![0x30,0x32].includes(data[1])||data[2]!==0x30||data[3]!==0x30)return this.reject('D7 未支援的旗標');
        values=[[13,data[0]-48],[12,Number(data[1]===0x32)]];
      }
      else return this.reject(`${cmd} 尚未支援`);
      for(const [id,raw] of values){const error=validateValue(this.service(id),raw);if(error)return this.reject(`${cmd} ${this.service(id).name}：${error}`);}
      const changes=values.map(([id,after])=>({id,before:this.service(id).raw,after}));
      for(const c of changes)this.service(c.id).raw=c.after;
      return {accepted:true,responses:[Uint8Array.of(ACK)],changes,reason:`${cmd} 已設定 · ${values.map(([id,v])=>this.service(id).name+' '+displayValue(this.service(id),v)).join(' / ')}`};
    }
    if(!['F','R'].includes(cmd[0]))return {accepted:false,responses:[],reason:'不是控制器查詢／控制命令；忽略'};
    if(data.length)return this.reject(`${String.fromCharCode(...b.slice(1,-2))} 未支援（本設定為 S21 v2）`);
    let payload;
    const v=id=>this.value(id);
    switch(cmd){
      case 'F1':payload=[48+v(0),48+v(1),28+v(3),v(2)];break;
      case 'F5':payload=[48+v(4),0x3f,0x30,0x80];break;
      case 'F6':payload=[0x30|(v(6)?2:0)|(v(7)?64:0)|(v(8)?128:0),0x30|(v(9)?128:0),0x30,0x30|(v(10)?8:0)|(v(11)?4:0)];break;
      case 'F7':payload=[48+v(13),v(12)?0x32:0x30,0x30,0x30];break;
      case 'F8':payload=ascii('0200');break;
      case 'F9':payload=[Math.trunc(v(20)/5)+128,Math.trunc(v(22)/5)+128,0xff,0x30];break;
      case 'FC':payload=ascii(this.profile.model.split('').reverse().join(''));break;
      case 'FM':payload=ascii(v(26).toString(16).toUpperCase().padStart(4,'0').split('').reverse().join(''));break;
      case 'RH':payload=temperature(v(20));break;
      case 'RI':payload=temperature(v(21));break;
      case 'Ra':payload=temperature(v(22));break;
      case 'RL':payload=reverseNumber(v(23),3);break;
      case 'Rd':payload=reverseNumber(v(24),3);break;
      case 'Re':payload=reverseNumber(v(25),3);break;
      default:payload=this.profile.rawReplies[cmd];
    }
    if(!payload)return this.reject(`${cmd} 未支援；NAK`);
    const reply=String.fromCharCode(cmd.charCodeAt(0)+1)+cmd[1];
    return {accepted:true,responses:[Uint8Array.of(ACK),frameS21(reply,payload)],reason:`${cmd} 查詢 ${S21_COMMANDS[cmd]||'機型原始回覆'}`};
  }
}
export function decodeS21(b){
  if(b.length===1)return b[0]===ACK?'S21 ACK · 確認':b[0]===NAK?'S21 NAK · 拒絕':'S21 控制字元';
  if(!checkS21(b))return 'S21 checksum／框架錯誤';
  const cmd=commandS21(b),query=['G','S'].includes(cmd[0])?String.fromCharCode(cmd.charCodeAt(0)-1)+cmd[1]:cmd;
  const data=Array.from(b.slice(3,-2));let values='';
  if(['G1','D1'].includes(cmd)&&data.length===4)values=`電源 ${data[0]-48} / 模式 ${data[1]-48} / ${(data[2]-28)/2} °C / 風速 ${String.fromCharCode(data[3])}`;
  else if(['G5','D5'].includes(cmd)&&data.length===4)values=`擺風 ${data[0]-48}`;
  else if(['SH','SI','Sa'].includes(cmd)&&data.length===4&&data.slice(0,3).every(b=>b>=48&&b<=57)&&[43,45].includes(data[3]))values=`${Number(String.fromCharCode(...data.slice(0,3).reverse()))*(data[3]===45?-1:1)/10} °C`;
  else if(['SL','Sd','Se'].includes(cmd)&&data.length===3&&data.every(b=>b>=48&&b<=57))values=`${Number(String.fromCharCode(...data.slice().reverse()))*(cmd==='SL'?10:1)} ${cmd==='SL'?'RPM':cmd==='Sd'?'Hz':'%'}`;
  else if(cmd==='GC'&&data.length===4)values=`模擬型號 ${String.fromCharCode(...data.slice().reverse())}`;
  return `S21 ${cmd} · ${S21_COMMANDS[query]||'原始命令'}${values?' · '+values:''}${data.length?' · DATA '+hex(data):''}`;
}
