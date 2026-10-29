import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscoveryParser,DiscoverySession,isTaiRequest,isS21Request} from '../dist/discovery.js';
import {frame} from '../dist/protocol.js';
import {ACK,NAK,frameS21,commandS21} from '../dist/s21.js';

const F1=frameS21('F1');
const G1=frameS21('G1',[0x30,0x33,0x50,0x41]);
const registration=frame(0,0,65535);
const typeQuery=frame(0,4,65535);
const target=sa=>frame(sa,0,65535);
const eventsOf=(events,type)=>events.filter(event=>event.type===type);

test('TaiSEIA Service FF error replies are not controller requests',()=>{
  const error=frame(4,255,1),parser=new DiscoveryParser(),session=new DiscoverySession();
  assert.equal(isTaiRequest(error),false);parser.push(error);assert.equal(parser.protocol,'auto');
  assert.equal(session.observe('taiseia',error).accepted,false);assert.equal(session.protocol,null);
});
test('traffic targeting another SA cannot refresh the accepted activity clock',()=>{
  const session=new DiscoverySession({deviceId:4});session.observe('taiseia',registration,100);
  session.sent('taiseia',registration,frame(0,0,[]),200);session.observe('taiseia',target(4),300);
  assert.equal(session.stage,'established');assert.equal(session.observe('taiseia',target(1),30300).accepted,false);
  assert.equal(session.lastRx,300);
});
test('S21 M, V and VS000M can be recognized without claiming v3 support',()=>{
  for(const command of ['M','V','VS000M']){const parser=new DiscoveryParser();const events=parser.push(frameS21(command));assert.equal(parser.protocol,'s21');assert.equal(events.length,1);assert.equal(events[0].type,'frame');}
});

function pendingS21(at=100) {
  const session=new DiscoverySession();
  assert.equal(session.observe('s21',F1,at-2).accepted,true);
  session.sent('s21',F1,Uint8Array.of(ACK),at-1);
  session.sent('s21',F1,G1,at);
  return session;
}

test('a bare 06 neither selects a protocol nor confirms a handshake',()=>{
  const parser=new DiscoveryParser();
  const session=new DiscoverySession();
  assert.deepEqual(parser.push([ACK],0),[]);
  assert.equal(parser.protocol,'auto');
  assert.equal(session.control(ACK,1).matched,false);
  assert.equal(session.protocol,null);
  assert.equal(session.stage,'waiting');
  assert.equal(session.confirmedAt,null);
  assert.equal(eventsOf(parser.expire(300),'error').length,1);
  assert.equal(parser.protocol,'auto');
});

test('every split of S21 F1 plus ACK produces one request followed by one control',()=>{
  const bytes=Uint8Array.from([...F1,ACK]);
  for(let split=1;split<bytes.length;split++) {
    const parser=new DiscoveryParser();
    const events=[...parser.push(bytes.slice(0,split),0),...parser.push(bytes.slice(split),1)];
    assert.deepEqual(events.map(event=>event.type),['frame','control'],`split ${split}`);
    assert.deepEqual(events[0].bytes,F1);
    assert.deepEqual(events[1].bytes,Uint8Array.of(ACK));
    assert.equal(parser.protocol,'s21');
    assert.equal(parser.buffer.length,0);
  }
});

test('coalesced S21 requests and control bytes retain order',()=>{
  const parser=new DiscoveryParser();
  const events=parser.push([...F1,ACK,...frameS21('F5'),NAK,...frameS21('RH')],0);
  assert.deepEqual(events.map(event=>event.type==='frame'?commandS21(event.bytes):event.bytes[0]),
    ['F1',ACK,'F5',NAK,'RH']);
  assert.equal(parser.protocol,'s21');
});

test('bad checksums cannot lock either protocol and a later valid frame recovers',()=>{
  for(const [protocol,valid] of [['s21',F1],['taiseia',registration]]) {
    const parser=new DiscoveryParser();
    const corrupt=Uint8Array.from(valid);
    corrupt[corrupt.length-(protocol==='s21'?2:1)]^=1;
    const rejected=parser.push(corrupt,0);
    assert.equal(eventsOf(rejected,'frame').length,0);
    assert.equal(parser.protocol,'auto');
    const accepted=parser.push(valid,1);
    assert.equal(eventsOf(accepted,'frame').length,1);
    assert.equal(parser.protocol,protocol);
  }
});

test('valid response echoes are not evidence of a controller request',()=>{
  for(const [protocol,bytes] of [['s21',G1],['taiseia',frame(0,4,4)]]) {
    const parser=new DiscoveryParser(), session=new DiscoverySession();
    const events=parser.push(bytes,0);
    assert.equal(eventsOf(events,'frame').length,1);
    assert.equal(parser.protocol,'auto');
    assert.equal(session.observe(protocol,bytes,1).accepted,false);
    assert.equal(session.protocol,null);
    assert.equal(session.confirmedAt,null);
  }
  assert.equal(isS21Request(G1),false);
  assert.equal(isTaiRequest(frame(0,4,4)),false);
});

test('TaiSEIA common queries identify the protocol without inferring the device type',()=>{
  const session=new DiscoverySession({deviceId:14,autoDevice:true});
  for(const service of [0,1,2,4,5,6,7,8]) {
    const result=session.observe('taiseia',frame(0,service,65535),service+1);
    assert.equal(result.accepted,true);
    assert.equal(result.changed,false);
    assert.equal(session.deviceId,14);
    assert.equal(session.deviceBasis,'selected');
    assert.equal(session.declared,false);
    assert.equal(session.confirmedAt,null);
  }
  assert.equal(session.protocol,'taiseia');
  assert.equal(session.stage,'detected');
});

test('the first targeted TaiSEIA request selects any supported SA automatically',()=>{
  for(const sa of [1,3,4,8,14,15]) {
    const session=new DiscoverySession({deviceId:1,autoDevice:true});
    const result=session.observe('taiseia',target(sa),10);
    assert.equal(result.accepted,true);
    assert.equal(result.changed,sa!==1);
    assert.equal(session.deviceId,sa);
    assert.equal(session.deviceBasis,'target-sa');
    assert.equal(session.declared,true);
    assert.equal(session.stage,'detected');
    assert.equal(session.confirmedAt,null,'a target alone is not a handshake');
  }
});

test('a manually selected device rejects a different target SA',()=>{
  const session=new DiscoverySession({deviceId:4,autoDevice:false});
  assert.equal(session.observe('taiseia',target(1),10).accepted,false);
  assert.equal(session.deviceId,4);
  assert.equal(session.declared,false);
  assert.equal(session.confirmedAt,null);
});

test('a profile already declared by identity TX never follows a different target SA',()=>{
  const session=new DiscoverySession({deviceId:4});
  session.observe('taiseia',typeQuery,10);
  session.sent('taiseia',typeQuery,frame(0,4,4),20);
  assert.equal(session.declared,true);
  assert.equal(session.observe('taiseia',target(1),30).accepted,false);
  assert.equal(session.deviceId,4);
  assert.equal(session.stage,'identity-sent');
  assert.equal(session.confirmedAt,null);
  assert.equal(session.observe('taiseia',target(4),40).accepted,true);
  assert.equal(session.stage,'established');
});

test('a profile declared by its first targeted request also rejects later SA changes',()=>{
  const session=new DiscoverySession();
  session.observe('taiseia',target(8),10);
  assert.equal(session.observe('taiseia',target(15),20).accepted,false);
  assert.equal(session.deviceId,8);
  assert.equal(session.confirmedAt,null);
});

test('TaiSEIA requires completed identity TX followed by a matching target to establish',()=>{
  const session=new DiscoverySession({deviceId:4});
  session.observe('taiseia',typeQuery,10);
  session.observe('taiseia',target(4),20);
  assert.equal(session.stage,'detected','observing the query does not prove identity TX');
  session.sent('taiseia',typeQuery,frame(0,4,4),30);
  assert.equal(session.stage,'identity-sent');
  assert.equal(session.confirmedAt,null,'TX completion alone is insufficient');
  session.observe('taiseia',frame(0,8,65535),40);
  assert.equal(session.stage,'identity-sent','another common query carries no target evidence');
  session.observe('taiseia',target(4),50);
  assert.equal(session.stage,'established');
  assert.equal(session.confirmedAt,50);
});

test('a target arriving outside the TaiSEIA identity window cannot establish',()=>{
  const session=new DiscoverySession({deviceId:4});
  session.observe('taiseia',typeQuery,10);
  session.sent('taiseia',typeQuery,frame(0,4,4),20);
  assert.equal(session.observe('taiseia',target(4),10021).accepted,true);
  assert.notEqual(session.stage,'established');
  assert.equal(session.confirmedAt,null);
});

test('S21 needs full response TX and then controller ACK before confirming',()=>{
  const session=new DiscoverySession();
  session.observe('s21',F1,10);
  assert.equal(session.stage,'detected');
  assert.equal(session.control(ACK,11).matched,false,'a premature ACK is not evidence');
  session.sent('s21',F1,Uint8Array.of(ACK),20);
  assert.equal(session.stage,'responding');
  assert.equal(session.pending,null);
  assert.equal(session.control(ACK,21).matched,false,'device ACK alone is insufficient');
  session.sent('s21',F1,G1,30);
  assert.equal(session.stage,'waiting-ack');
  assert.equal(session.confirmedAt,null);
  assert.equal(session.control(ACK,40).matched,true);
  assert.equal(session.stage,'confirmed');
  assert.equal(session.confirmedAt,40);
  assert.equal(session.pending,null);
  assert.equal(session.control(ACK,41).matched,false,'duplicate ACK is not another exchange');
});

test('S21 setter ACK does not create a pending response handshake',()=>{
  const session=new DiscoverySession();
  const request=frameS21('D1',[0x31,0x33,0x50,0x41]);
  session.observe('s21',request,10);
  session.sent('s21',request,Uint8Array.of(ACK),20);
  assert.equal(session.pending,null);
  assert.equal(session.control(ACK,30).matched,false);
  assert.equal(session.confirmedAt,null);
});

test('a new S21 poll without controller ACK remains unconfirmed and can recover',()=>{
  const session=pendingS21();
  session.observe('s21',F1,110);
  assert.equal(session.stage,'no-ack');
  assert.equal(session.pending,null);
  assert.equal(session.confirmedAt,null);
  session.sent('s21',F1,G1,120);
  assert.equal(session.control(ACK,130).matched,true);
  assert.equal(session.stage,'confirmed');
});

test('S21 NAK rejects the matching pending response',()=>{
  const session=pendingS21();
  assert.equal(session.control(NAK,110).matched,true);
  assert.equal(session.stage,'rejected');
  assert.equal(session.pending,null);
  assert.equal(session.confirmedAt,null);
});

test('S21 ACK timeout clears pending evidence and a late NAK cannot confirm',()=>{
  const session=pendingS21();
  assert.equal(session.expire(1100),false);
  assert.equal(session.expire(1101),true);
  assert.equal(session.stage,'ack-timeout');
  assert.equal(session.pending,null);
  assert.equal(session.confirmedAt,null);
  assert.equal(session.control(NAK,1102).matched,false);
  assert.equal(session.stage,'ack-timeout');
});

for(const [name,byte] of [['ACK',ACK],['NAK',NAK]]) {
  test(`late S21 ${name} updates timeout state even before the expiry timer runs`,()=>{
    const session=pendingS21();
    assert.equal(session.control(byte,1101).matched,false);
    assert.equal(session.pending,null);
    assert.equal(session.stage,'ack-timeout');
    assert.equal(session.confirmedAt,null);
    assert.equal(session.expire(1200),false);
    session.observe('s21',F1,1300);
    session.sent('s21',F1,G1,1310);
    assert.equal(session.control(ACK,1320).matched,true);
    assert.equal(session.stage,'confirmed');
  });
}

test('a later timed-out S21 exchange invalidates an earlier handshake confirmation',()=>{
  const session=pendingS21();
  session.control(ACK,110);
  session.observe('s21',F1,200);
  session.sent('s21',F1,G1,210);
  assert.equal(session.expire(1211),true);
  assert.equal(session.stage,'ack-timeout');
  assert.equal(session.confirmedAt,null);
});

test('both protocols recover from ordinary noise and complete corrupt frames',()=>{
  for(const [protocol,valid] of [['s21',F1],['taiseia',registration]]) {
    const parser=new DiscoveryParser();
    const corrupt=Uint8Array.from(valid);
    corrupt[corrupt.length-(protocol==='s21'?2:1)]^=1;
    const events=parser.push([0xFF,0x7F,...corrupt,...valid],0);
    assert(eventsOf(events,'error').length>0);
    assert.deepEqual(eventsOf(events,'frame').map(event=>Array.from(event.bytes)),[Array.from(valid)]);
    assert.equal(parser.protocol,protocol);
    assert.equal(parser.buffer.length,0);
  }
});

test('a false TaiSEIA length prefix does not hide a valid S21 request',()=>{
  const parser=new DiscoveryParser();
  const events=parser.push([0x06,...F1],0);
  assert.deepEqual(eventsOf(events,'frame').map(event=>Array.from(event.bytes)),[Array.from(F1)]);
  assert.equal(parser.protocol,'s21');
});

test('a stale false S21 start can recover the following TaiSEIA request',()=>{
  const parser=new DiscoveryParser();
  const events=[...parser.push([0x02,0x7F,...registration],0),...parser.expire(300)];
  assert.deepEqual(eventsOf(events,'frame').map(event=>Array.from(event.bytes)),[Array.from(registration)]);
  assert.equal(parser.protocol,'taiseia');
});

test('a corrupt S21 prefix must not consume the next complete valid S21 request',()=>{
  const parser=new DiscoveryParser();
  const events=parser.push([0x02,0x7F,0x7F,...F1],0);
  assert(eventsOf(events,'error').length>0);
  assert.deepEqual(eventsOf(events,'frame').map(event=>Array.from(event.bytes)),[Array.from(F1)]);
  assert.equal(parser.protocol,'s21');
});

test('a locked session rejects the other protocol until reset',()=>{
  for(const [protocol,request,other,otherRequest] of [
    ['s21',F1,'taiseia',registration],['taiseia',registration,'s21',F1],
  ]) {
    const session=new DiscoverySession();
    assert.equal(session.observe(protocol,request,10).accepted,true);
    assert.equal(session.observe(other,otherRequest,20).accepted,false);
    assert.equal(session.protocol,protocol);
    session.reset();
    assert.equal(session.observe(other,otherRequest,30).accepted,true);
    assert.equal(session.protocol,other);
  }
});
