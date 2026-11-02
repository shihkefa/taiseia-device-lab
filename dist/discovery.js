import {checkFrame} from './protocol.js?v=1.3.8';
import {checkS21,commandS21,ACK,NAK} from './s21.js?v=1.3.8';
import {checkCN105,isCN105Request} from './cn105.js?v=1.3.8';
export const SERIAL_PRESETS={taiseia:{baudRate:9600,dataBits:8,parity:'none',stopBits:1},s21:{baudRate:2400,dataBits:8,parity:'even',stopBits:2},cn105:{baudRate:2400,dataBits:8,parity:'even',stopBits:1}};
const SA_IDS=[1,3,4,8,14,15];
export function isTaiRequest(b){return b.length===6&&checkFrame(b)&&(b[1]===0?b[2]<=8&&b[2]!==3&&b[3]===255&&b[4]===255:SA_IDS.includes(b[1])&&(b[2]&127)!==127&&((b[2]&128)!==0||(b[3]===255&&b[4]===255)));}
export function isS21Request(b){return checkS21(b)&&(/^[FDR][A-Za-z0-9]$/.test(commandS21(b))||['M','V','VS000M'].includes(commandS21(b)));}
// Unknown 06 is held as a possible TaiSEIA length. It is only treated as an ACK
// after S21 has been selected or recognized from a complete valid command.
export class DiscoveryParser {
  constructor({protocol='auto',staleMs=300,maxBuffer=4096}={}){this.protocol=protocol;this.staleMs=staleMs;this.maxBuffer=maxBuffer;this.buffer=[];this.last=0;}
  clear(){this.buffer=[];}
  reset(protocol='auto'){this.clear();this.protocol=protocol;}
  push(bytes,now=performance.now()){
    const events=this.expire(now);this.buffer.push(...bytes);this.last=now;
    if(this.buffer.length>this.maxBuffer)return [...events,{type:'error',bytes:this.buffer.splice(0),reason:'接收緩衝超出上限'}];
    return [...events,...this.drain(false)];
  }
  expire(now=performance.now()){return this.buffer.length&&now-this.last>=this.staleMs?this.drain(true):[];}
  drain(stale){
    const events=[];
    while(this.buffer.length){
      const first=this.buffer[0],allowS21=['auto','s21'].includes(this.protocol),allowTai=['auto','taiseia'].includes(this.protocol);
      if(['auto','cn105'].includes(this.protocol)&&first===0xfc){
        const length=this.buffer.length>=5?this.buffer[4]+6:null;
        if(this.buffer.length>=4&&(this.buffer[2]!==1||this.buffer[3]!==0x30)||length>70){events.push({type:'error',protocol:'cn105',bytes:this.buffer.splice(0,1),reason:'CN105 標頭／長度不符；重新同步'});continue;}
        if(length===null||this.buffer.length<length){if(!stale)break;events.push({type:'error',protocol:'cn105',bytes:this.buffer.splice(0,1),reason:'CN105 殘包逾時；重新同步'});continue;}
        const bytes=Uint8Array.from(this.buffer.slice(0,length));
        if(!checkCN105(bytes)){const next=this.buffer.findIndex((b,i)=>i>0&&b===0xfc&&this.buffer[i+2]===1&&this.buffer[i+3]===0x30);events.push({type:'error',protocol:'cn105',bytes:this.buffer.splice(0,next>0?next:length),reason:'CN105 checksum 不符；靜默丟棄並重新同步'});continue;}
        this.buffer.splice(0,length);if(this.protocol==='auto'&&isCN105Request(bytes))this.protocol='cn105';
        events.push({type:'frame',protocol:'cn105',bytes});continue;
      }
      if(this.protocol==='s21'&&[ACK,NAK].includes(first)){events.push({type:'control',protocol:'s21',bytes:Uint8Array.from(this.buffer.splice(0,1))});continue;}
      if(allowS21&&first===2){
        const end=this.buffer.indexOf(3,3);
        // A stray S21 STX must not eat a complete request from another family.
        // Test the current full frame first, so binary payload is not resliced.
        if(this.protocol==='auto'&&(end<0||!checkS21(this.buffer.slice(0,end+1)))){
          const next=this.buffer.findIndex((b,i)=>i>0&&(b===0xfc&&i+5<=this.buffer.length&&isCN105Request(this.buffer.slice(i,i+6+this.buffer[i+4]))||b===6&&isTaiRequest(this.buffer.slice(i,i+6))));
          if(next>0){events.push({type:'error',protocol:'auto',bytes:this.buffer.splice(0,next),reason:'前導 STX 與後續協議不符；保留完整有效控制器命令'});continue;}
        }
        const restart=this.buffer.indexOf(2,1);
        if(restart>0&&(end<0||restart<end)){events.push({type:'error',protocol:'s21',bytes:this.buffer.splice(0,restart),reason:'S21 新 STX；捨棄未完成前綴'});continue;}
        if(end<0){if(!stale&&this.buffer.length<=131)break;events.push({type:'error',protocol:'s21',bytes:this.buffer.splice(0,1),reason:'S21 殘包逾時／超長'});continue;}
        const bytes=Uint8Array.from(this.buffer.splice(0,end+1));
        if(!checkS21(bytes)){events.push({type:'error',protocol:'s21',bytes,reason:'S21 checksum 不符；靜默丟棄'});continue;}
        if(this.protocol==='auto'&&isS21Request(bytes))this.protocol='s21';
        events.push({type:'frame',protocol:'s21',bytes});continue;
      }
      if(allowTai&&first===6){
        if(this.buffer.length<6){if(!stale)break;events.push({type:'error',protocol:this.protocol,bytes:this.buffer.splice(0,1),reason:'未完成的 TaiSEIA 請求／未辨識 ACK'});continue;}
        const bytes=Uint8Array.from(this.buffer.slice(0,6));
        if(this.protocol==='auto'&&!isTaiRequest(bytes)&&isTaiRequest(this.buffer.slice(1,7))){events.push({type:'error',protocol:'taiseia',bytes:this.buffer.splice(0,1),reason:'前導 06 形成非請求框架；重新對齊有效控制器命令'});continue;}
        if(checkFrame(bytes)){this.buffer.splice(0,6);if(this.protocol==='auto'&&isTaiRequest(bytes))this.protocol='taiseia';events.push({type:'frame',protocol:'taiseia',bytes});continue;}
        events.push({type:'error',protocol:'taiseia',bytes:this.buffer.splice(0,1),reason:'TaiSEIA XOR 不符；重新同步'});continue;
      }
      events.push({type:'error',protocol:this.protocol,bytes:this.buffer.splice(0,1),reason:'未辨識位元組／目前協議不符'});
    }
    return events;
  }
}
// Evidence is separate from the simulated profile we choose to advertise.
// No serial open, bare ACK or TX completion alone can establish a handshake.
export class DiscoverySession {
  #cn105Followups=new WeakSet();
  constructor(options={}){this.reset(options);}
  reset({protocol='auto',deviceId=1,autoDevice=true}={}){
    this.configuredProtocol=protocol;this.protocol=null;this.deviceId=deviceId;this.autoDevice=autoDevice;
    this.deviceBasis='selected';this.declared=false;this.identitySent=false;this.pending=null;
    this.stage='waiting';this.evidence='等待有效控制器命令';this.lastRx=null;this.confirmedAt=null;
    this.#cn105Followups=new WeakSet();
  }
  observe(protocol,bytes,now=performance.now()){
    if(!['s21','taiseia','cn105'].includes(protocol)||(protocol==='cn105'&&!isCN105Request(bytes))||(protocol==='s21'&&!isS21Request(bytes))||(protocol==='taiseia'&&!isTaiRequest(bytes)))return {accepted:false,reason:'不是可辨識的控制器命令'};
    if(this.configuredProtocol!=='auto'&&protocol!==this.configuredProtocol||this.protocol&&protocol!==this.protocol)return {accepted:false,reason:'協議與已鎖定連線不符'};
    this.protocol=protocol;
    let changed=false;
    if(protocol==='cn105'){
      changed=this.deviceId!=='cn105';this.deviceId='cn105';this.deviceBasis='cn105-family';
      if([0x5a,0x5b].includes(bytes[1])){this.#cn105Followups=new WeakSet();this.identitySent=false;this.confirmedAt=null;this.stage='detected';this.evidence='收到 CN105 連線請求；尚未送出回覆';}
      else if(this.identitySent&&now-this.identitySent.at<=10000){this.#cn105Followups.add(bytes);if(this.confirmedAt===null)this.evidence='已收到 CN105 後續 GET／SET，等待支援的命令成功回覆';}
    }else if(protocol==='s21'){
      changed=this.deviceId!=='s21';this.deviceId='s21';this.deviceBasis='s21-family';
      if(this.pending){this.pending=null;this.stage='no-ack';this.evidence='控制器未回 ACK 即開始下一查詢；持續回覆，尚無 ACK 確認';}
    }else if(bytes[1]!==0){
      if(this.declared&&bytes[1]!==this.deviceId)return {accepted:false,reason:'控制器目標 SA 與本輪已宣告的設備不符；請重新偵測'};
      if(!this.declared&&this.autoDevice){changed=this.deviceId!==bytes[1];this.deviceId=bytes[1];}
      if(bytes[1]!==this.deviceId)return {accepted:false,reason:'控制器目標 SA 與手動選定設備不符'};
      this.deviceBasis='target-sa';this.declared=true;
      if(this.identitySent&&now-this.identitySent.at<=10000){this.stage='established';this.evidence='已回覆設備識別，控制器接著定址此 SA；TaiSEIA 無獨立回覆 ACK';this.confirmedAt=now;}
    }
    this.lastRx=now;
    if(this.stage==='waiting'){this.stage='detected';this.evidence='已收到校驗正確的控制器命令';}
    return {accepted:true,changed,deviceId:this.deviceId};
  }
  sent(protocol,request,response,now=performance.now()){
    if(protocol==='cn105'){
      if(request[1]===0x5a&&response[1]===0x7a){this.identitySent={at:now};this.stage='identity-sent';this.evidence='已送出 CN105 7A 連線回覆，等待控制器後續 GET／SET 確認';}
      else if(this.#cn105Followups.has(request)&&checkCN105(response)&&((request[1]===0x42&&response[1]===0x62&&request[5]===response[5])||(request[1]===0x41&&response[1]===0x61))){this.#cn105Followups.delete(request);this.stage='established';this.confirmedAt=now;this.evidence='已完成 CONNECT → 7A → 後續 GET／SET → 62／61 回覆；CN105 無控制器 ACK';}
      else if(this.confirmedAt===null){this.stage='responding';this.evidence='已回覆 CN105 查詢／寫入，尚未觀察到完整 CONNECT 流程';}
    }else if(protocol==='s21'&&response.length>1){
      this.pending={at:now,command:commandS21(response)};
      if(!this.confirmedAt){this.stage='waiting-ack';this.evidence='已送出 ACK 與狀態封包，等待控制器 ACK';}
    }else if(protocol==='taiseia'){
      if(request[1]===0&&[0,4].includes(request[2])){
        this.declared=true;this.identitySent={at:now};
        if(!this.confirmedAt){this.stage='identity-sent';this.evidence='已宣告模擬設備；等待控制器定址查詢確認';}
      }else if(!this.confirmedAt){this.stage='responding';this.evidence='已回覆查詢／控制；尚未觀察到完整識別流程';}
    }else if(protocol==='s21'&&response[0]===ACK&&!this.confirmedAt){this.stage='responding';this.evidence='已回覆寫入 ACK；等待查詢與控制器確認';}
  }
  control(byte,now=performance.now()){
    if(this.protocol!=='s21'||!this.pending)return {matched:false,reason:'未配對的 S21 控制字元，不能作為握手證據'};
    const pending=this.pending;this.pending=null;
    if(now-pending.at>1000){this.stage='ack-timeout';this.confirmedAt=null;this.evidence='ACK/NAK 超過 1000ms 配對期限';return {matched:false,reason:this.evidence};}
    this.lastRx=now;
    if(byte===ACK){this.stage='confirmed';this.confirmedAt=now;this.evidence=`已完成查詢 → ACK → ${pending.command} → 控制器 ACK`;return {matched:true,reason:this.evidence};}
    this.stage='rejected';this.confirmedAt=null;this.evidence=`控制器以 NAK 拒絕 ${pending.command}`;return {matched:true,reason:this.evidence};
  }
  expire(now=performance.now()){
    if(this.pending&&now-this.pending.at>1000){this.pending=null;this.stage='ack-timeout';this.confirmedAt=null;this.evidence='控制器 ACK 逾時；仍可處理後續查詢';return true;}
    return false;
  }
}
