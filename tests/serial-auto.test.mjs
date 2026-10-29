import test from 'node:test';
import assert from 'node:assert/strict';
import {SerialTransport} from '../dist/serial.js';

const TAISEIA = {baudRate:9600,dataBits:8,stopBits:1,parity:'none'};
const S21 = {baudRate:2400,dataBits:8,stopBits:2,parity:'even'};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

// Each successful open creates separate streams, so a write can be attributed
// to the exact opening of this same physical port. Hooks make races deterministic.
function fakeSerial(openHooks=[]) {
  const opens=[], writes=[], listeners=new Set();
  let requests=0, closes=0, isOpen=false;
  const port={
    readable:null,
    writable:null,
    async open(options) {
      assert.equal(isOpen,false,'the old port must close before reopening');
      const cycle=opens.length+1;
      opens.push({...options});
      await openHooks[cycle-1]?.();
      isOpen=true;
      this.readable=new ReadableStream();
      this.writable=new WritableStream({
        write(bytes) {writes.push({cycle,bytes:Array.from(bytes)});},
      });
    },
    async close() {
      assert.equal(isOpen,true);
      assert.equal(this.readable.locked,false,'release the reader before close');
      assert.equal(this.writable.locked,false,'release the writer before close');
      closes++;
      isOpen=false;
      this.readable=null;
      this.writable=null;
    },
    getInfo() {return {usbVendorId:0x1234,usbProductId:0x5678};},
  };
  const api={
    async requestPort() {requests++;return port;},
    addEventListener(type,listener) {
      assert.equal(type,'disconnect');
      listeners.add(listener);
    },
    removeEventListener(type,listener) {
      assert.equal(type,'disconnect');
      listeners.delete(listener);
    },
  };
  return {port,api,opens,writes,listeners,
    get requests(){return requests;},
    get closes(){return closes;},
    get isOpen(){return isOpen;},
  };
}

test('reconfigure reopens the granted port without requesting another port',
  {timeout:2000},async context=>{
    const fake=fakeSerial(), states=[];
    const transport=new SerialTransport({onState:(...args)=>states.push(args)});
    context.after(()=>transport.disconnect());
    assert.equal(await transport.connect(TAISEIA,fake.api),true);
    const initialSession=transport.session;
    assert.equal(await transport.reconfigure(S21),true);
    assert.equal(fake.requests,1);
    assert.deepEqual(fake.opens,[TAISEIA,S21]);
    assert.equal(fake.closes,1);
    assert.equal(transport.session.port,fake.port);
    assert.notEqual(transport.session,initialSession);
    assert.equal(initialSession.active,false);
    assert.equal(fake.listeners.size,1,'replace the prior disconnect listener');
    assert.equal(transport.connected,true);
    assert.equal(transport.opening,false);
    assert.deepEqual(states.map(([connected,,meta])=>({connected,...meta})),[
      {connected:true,reconfigured:false,options:TAISEIA},
      {connected:true,reconfigured:true,options:S21},
    ]);
    assert.equal(await transport.send([0x02,0x46,0x31]),true);
    assert.deepEqual(fake.writes,[{cycle:2,bytes:[0x02,0x46,0x31]}]);
  });

test('reconfigure cancels delayed and queued replies from the previous session',
  {timeout:2000},async context=>{
    const fake=fakeSerial(), sent=[];
    const transport=new SerialTransport();
    context.after(()=>transport.disconnect());
    await transport.connect(TAISEIA,fake.api);
    const oldSession=transport.session;
    const delayed=transport.send([0xAA],60_000,bytes=>sent.push(Array.from(bytes)));
    const queued=transport.send([0xBB],0,bytes=>sent.push(Array.from(bytes)));
    await Promise.resolve();
    assert.equal(typeof oldSession.cancelDelay,'function','the delay has begun');
    assert.equal(await transport.reconfigure(S21),true);
    assert.deepEqual(await Promise.all([delayed,queued]),[false,false]);
    assert.deepEqual(fake.writes,[]);
    assert.deepEqual(sent,[],'cancelled replies must not report successful TX');
    assert.equal(oldSession.cancelDelay,null);
    await transport.send([0xCC],0,bytes=>sent.push(Array.from(bytes)));
    assert.deepEqual(fake.writes,[{cycle:2,bytes:[0xCC]}]);
    assert.deepEqual(sent,[[0xCC]]);
  });

test('disconnect during the first pending port.open cannot revive the connection',
  {timeout:2000},async context=>{
    const started=deferred(), release=deferred(), states=[];
    const fake=fakeSerial([async()=>{started.resolve();await release.promise;}]);
    const transport=new SerialTransport({onState:connected=>states.push(connected)});
    context.after(()=>transport.disconnect());
    const connecting=transport.connect(TAISEIA,fake.api);
    await started.promise;
    assert.equal(transport.opening,true);
    await transport.disconnect();
    release.resolve();
    assert.equal(await connecting,false);
    assert.equal(transport.connected,false);
    assert.equal(transport.session,null);
    assert.equal(transport.opening,false);
    assert.equal(fake.isOpen,false);
    assert.equal(fake.closes,1);
    assert.equal(fake.listeners.size,0);
    assert.deepEqual(states,[false]);
    assert.equal(await transport.connect(S21,fake.api),true,
      'a cancelled open must permit a later explicit connect');
  });

test('disconnect during reconfigure closes the pending reopening without reviving it',
  {timeout:2000},async context=>{
    const started=deferred(), release=deferred(), states=[];
    const fake=fakeSerial([undefined,async()=>{started.resolve();await release.promise;}]);
    const transport=new SerialTransport({onState:connected=>states.push(connected)});
    context.after(()=>transport.disconnect());
    await transport.connect(TAISEIA,fake.api);
    const reconfiguring=transport.reconfigure(S21);
    await started.promise;
    assert.equal(fake.closes,1);
    await transport.disconnect();
    release.resolve();
    assert.equal(await reconfiguring,false);
    assert.equal(transport.connected,false);
    assert.equal(transport.session,null);
    assert.equal(transport.opening,false);
    assert.equal(fake.requests,1);
    assert.equal(fake.closes,2);
    assert.equal(fake.isOpen,false);
    assert.equal(fake.listeners.size,0);
    assert.deepEqual(states,[true,false]);
  });

test('a failed reconfigure leaves a disconnected transport that can connect again',
  {timeout:2000},async context=>{
    const failure=new Error('unsupported serial framing'), states=[];
    const fake=fakeSerial([undefined,async()=>{throw failure;}]);
    const transport=new SerialTransport({onState:connected=>states.push(connected)});
    context.after(()=>transport.disconnect());
    await transport.connect(TAISEIA,fake.api);
    await assert.rejects(transport.reconfigure(S21),error=>error===failure);
    assert.equal(transport.connected,false);
    assert.equal(transport.session,null);
    assert.equal(transport.opening,false);
    assert.equal(fake.isOpen,false);
    assert.equal(fake.listeners.size,0);
    assert.equal(fake.requests,1);
    assert.deepEqual(states,[true,false]);
    await assert.rejects(transport.send([0xAA]),/尚未連接串口/);
    assert.equal(await transport.connect(TAISEIA,fake.api),true);
    assert.equal(fake.requests,2);
    assert.deepEqual(fake.opens,[TAISEIA,S21,TAISEIA]);
    await transport.send([0xDD]);
    assert.deepEqual(fake.writes,[{cycle:3,bytes:[0xDD]}]);
  });
