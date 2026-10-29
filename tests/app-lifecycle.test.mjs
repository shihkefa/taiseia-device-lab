import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

let instance=0;
const appUrl=new URL('../dist/app.js',import.meta.url);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

// The app is exercised through its event handlers, rendered text, Web Serial
// streams and existing read-only inspection tool. No private app state is exposed.
async function appHarness(context,{holdOpen=false,mockClock=false}={}) {
  const elements=new Map(),tools=new Map(),originals=new Map(),connections=[];
  const intervals=[],opens=[],writes=[];
  const request=deferred(),openGate=deferred(),openStarted=deferred();
  let incoming,now=0,requestCount=0,closeCount=0;
  function element(id) {
    if(!elements.has(id))elements.set(id,{
      value:'',checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',
      dataset:{},scrollTop:0,clientHeight:0,scrollHeight:0,
      classList:{toggle(){},add(){},remove(){}},handlers:new Map(),
      addEventListener(type,fn){this.handlers.set(type,fn);},
      querySelectorAll(){return [];},
    });
    return elements.get(id);
  }
  function fire(id,type='click',extra={}) {
    // Programmatic events still reach listeners on disabled controls. This also
    // checks the opening guards independently of their visible disabled state.
    return element(id).handlers.get(type)?.({target:element(id),...extra});
  }
  const port={
    readable:null,writable:null,
    async open(options) {
      opens.push({port:this,options:{...options}});
      openStarted.resolve();
      if(holdOpen)await openGate.promise;
      this.readable=new ReadableStream({start(controller){incoming=controller;}});
      this.writable=new WritableStream({write(bytes){writes.push(Array.from(bytes));}});
    },
    async close(){closeCount++;this.readable=null;this.writable=null;},
    getInfo(){return {usbVendorId:0x1234};},
  };
  function setGlobal(name,value) {
    originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  }
  for(const [id,value] of Object.entries({
    'protocol-mode':'auto','serial-mode':'auto',baud:'9600',
    'data-bits':'8',parity:'none','stop-bits':'1',
  }))element(id).value=value;
  element('auto-device').checked=true;
  element('auto-reply').checked=true;
  setGlobal('document',{
    getElementById:element,querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener(){},activeElement:null,
  });
  setGlobal('window',{addEventListener(){}});
  setGlobal('isSecureContext',true);
  // Render callbacks are unnecessary for these assertions. Scan intervals are
  // driven explicitly so UART timing is tested without waiting in real time.
  setGlobal('requestAnimationFrame',()=>0);
  setGlobal('setInterval',(callback,delay)=>{intervals.push({callback,delay});return intervals.length;});
  if(mockClock)setGlobal('performance',{now:()=>now});
  setGlobal('navigator',{
    serial:{requestPort:()=>{requestCount++;return request.promise;},addEventListener(){},removeEventListener(){}},
    modelContext:{registerTool(tool){tools.set(tool.name,tool);}},
  });
  context.after(async()=>{
    try {
      request.resolve(port);openGate.resolve();
      await Promise.allSettled(connections);
      await fire('disconnect');
    } finally {
      for(const [name,descriptor] of originals) {
        if(descriptor)Object.defineProperty(globalThis,name,descriptor);
        else delete globalThis[name];
      }
    }
  });
  // Only resolve imports and make each module instance unique. Execute the
  // actual app unchanged, without adding exports or replacing its implementation.
  const source=(await readFile(appUrl,'utf8'))
    .replace(/from '(\.\/[^']+)'/g,(_,name)=>`from '${new URL(name,appUrl).href}'`)
    +`\n// isolated test instance ${++instance}\n`;
  await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  return {
    element,fire,request,openGate,openStarted,port,opens,writes,
    get requestCount(){return requestCount;},
    get closeCount(){return closeCount;},
    connect(){const pending=fire('connect');connections.push(pending);return pending;},
    async push(bytes){incoming.enqueue(Uint8Array.from(bytes));await settle();},
    async advanceTo(time){
      assert.equal(mockClock,true,'advancing time requires a mocked clock');
      assert(time>=now,'the monotonic clock cannot move backwards');
      now=time;
      assert(intervals.length>0,'the app registered its periodic scan callback');
      for(const interval of intervals)interval.callback();
      // tickScan is intentionally launched without awaiting by the real app.
      // Flush its stream cancellation, close and reopen microtasks before asserting.
      await settle();
    },
    async inspect(){
      const tool=tools.get('inspect_taiseia_lab');
      assert(tool,'the public read-only app inspection tool was registered');
      const result=await tool.execute({});
      return JSON.parse(result.content.find(item=>item.type==='text').text);
    },
  };
}

for(const phase of ['requestPort','port.open']) {
  test(`offline controls cannot inject handshake evidence while ${phase} is pending`,
    {timeout:3000,concurrency:false},async context=>{
      const app=await appHarness(context,{holdOpen:phase==='port.open'});
      const connecting=app.connect();
      if(phase==='port.open') {
        app.request.resolve(app.port);
        await app.openStarted.promise;
      }
      for(const id of ['protocol-mode','serial-mode','device-type','auto-device',
        'rescan','demo','inject','test-command','import-profile']) {
        assert.equal(app.element(id).disabled,true,`${id} is disabled while opening`);
      }
      app.element('test-command').value='02 46 31 77 03';
      app.fire('inject');
      app.element('test-command').value='06';
      app.fire('inject');
      app.fire('demo');
      const opening=await app.inspect();
      assert.equal(opening.connected,false);
      assert.equal(opening.device.saId,1);
      assert.equal(opening.counts.RX,0);
      assert.equal(opening.counts.TX,0);
      assert.equal(opening.records.some(record=>record.source==='離線'),false);
      app.request.resolve(app.port);
      app.openGate.resolve();
      await connecting;
      assert.equal((await app.inspect()).connected,true);
      await app.push([0xFF]);
      assert.equal(app.element('detected-protocol').textContent,'尚未偵測');
      assert.equal(app.element('handshake-state').textContent,'等待命令');
      assert.doesNotMatch(app.element('handshake-evidence').textContent,/已完成查詢|離線/);
    });
}

test('the first physical S21 chunk is unknown until decoded and needs a physical ACK',
  {timeout:3000,concurrency:false},async context=>{
    const app=await appHarness(context);
    const connecting=app.connect();
    app.request.resolve(app.port);
    await connecting;
    await app.push([0x02,0x46,0x31,0x77,0x03]);
    const state=await app.inspect();
    const raw=state.records.find(record=>record.direction==='RX'&&record.kind==='chunk');
    const parsed=state.records.find(record=>record.direction==='RX'&&record.kind==='frame');
    assert.equal(raw.source,'串口');
    assert.equal(raw.protocol,'unknown');
    assert.deepEqual(raw.bytes,[0x02,0x46,0x31,0x77,0x03]);
    assert.equal(parsed.source,'串口');
    assert.equal(parsed.protocol,'s21');
    assert.equal(state.device.saId,'s21');
    assert.equal(app.element('detected-protocol').textContent,'Daikin S21');
    assert.equal(app.element('handshake-state').textContent,'等待控制器 ACK');
    assert.equal(state.records.some(record=>record.source==='離線'),false);
    await app.push([0x06]);
    assert.equal(app.element('handshake-state').textContent,'握手已確認（ACK）');
    const ack=(await app.inspect()).records.find(record=>
      record.direction==='RX'&&record.kind==='frame'&&record.bytes.length===1);
    assert.equal(ack.source,'串口');
    assert.equal(ack.protocol,'s21');
  });

test('cancelling port selection restores editable controls without leaving handshake evidence',
  {timeout:3000,concurrency:false},async context=>{
    const app=await appHarness(context);
    const connecting=app.connect();
    const cancelled=new Error('user cancelled');cancelled.name='NotFoundError';
    app.request.reject(cancelled);
    await connecting;
    for(const id of ['connect','protocol-mode','serial-mode','device-type',
      'auto-device','rescan','demo','inject','test-command','import-profile']) {
      assert.equal(app.element(id).disabled,false,`${id} is restored after cancellation`);
    }
    assert.equal((await app.inspect()).connected,false);
    assert.equal(app.element('handshake-state').textContent,'等待命令');
    assert.match(app.element('notice').textContent,/取消/);
  });

test('automatic UART scanning reopens the same port after four seconds and stops on valid S21',
  {timeout:3000,concurrency:false},async context=>{
    const app=await appHarness(context,{mockClock:true});
    const connecting=app.connect();
    app.request.resolve(app.port);
    await connecting;
    const tai={baudRate:9600,dataBits:8,parity:'none',stopBits:1,flowControl:'none',bufferSize:4096};
    const s21={baudRate:2400,dataBits:8,parity:'even',stopBits:2,flowControl:'none',bufferSize:4096};
    assert.deepEqual(app.opens.map(open=>open.options),[tai]);
    assert.equal(app.requestCount,1);
    assert.match(app.element('scan-status').textContent,/偵測中/);
    await app.push([0x06]);
    await app.advanceTo(3999);
    assert.equal(app.opens.length,1,'a bare ACK neither locks nor advances the scanner early');
    await app.advanceTo(4000);
    assert.deepEqual(app.opens.map(open=>open.options),[tai,s21]);
    assert(app.opens.every(open=>open.port===app.port));
    assert.equal(app.requestCount,1,'automatic reconfiguration reuses the granted port');
    assert.equal(app.closeCount,1);
    assert.equal(Number(app.element('baud').value),2400);
    assert.equal(app.element('parity').value,'even');
    assert.equal(Number(app.element('stop-bits').value),2);
    await app.push([0x02,0x46,0x31,0x77,0x03]);
    assert.equal(app.element('detected-protocol').textContent,'Daikin S21');
    assert.match(app.element('scan-status').textContent,/協議已鎖定/);
    assert.doesNotMatch(app.element('scan-status').textContent,/偵測中/);
    await app.push([0x06]);
    assert.equal(app.element('handshake-state').textContent,'握手已確認（ACK）');
    for(const time of [8000,60000,120000])await app.advanceTo(time);
    assert.equal(app.opens.length,2,'a valid protocol lock prevents all later UART rotation');
    assert.equal(app.closeCount,1);
    assert.equal(app.requestCount,1);
    assert.equal((await app.inspect()).connected,true);
  });

test('automatic UART scanning times out at sixty seconds and never reopens afterwards',
  {timeout:3000,concurrency:false},async context=>{
    const app=await appHarness(context,{mockClock:true});
    const connecting=app.connect();
    app.request.resolve(app.port);
    await connecting;
    for(let time=4000;time<60000;time+=4000)await app.advanceTo(time);
    assert.equal(app.opens.length,15,'initial open plus fourteen four-second rotations');
    assert.equal(app.closeCount,14);
    assert.equal(app.requestCount,1);
    for(const [index,open] of app.opens.entries()) {
      assert.equal(open.port,app.port);
      assert.deepEqual(
        [open.options.baudRate,open.options.dataBits,open.options.parity,open.options.stopBits],
        index%2?[2400,8,'even',2]:[9600,8,'none',1],
      );
    }
    await app.advanceTo(59999);
    assert.match(app.element('scan-status').textContent,/偵測中/);
    await app.advanceTo(60000);
    assert.match(app.element('notice').textContent,/60 秒內尚未收到有效命令/);
    assert.doesNotMatch(app.element('scan-status').textContent,/偵測中/);
    assert.equal(app.element('detected-protocol').textContent,'尚未偵測');
    assert.equal(app.element('handshake-state').textContent,'等待命令');
    for(const time of [64000,120000])await app.advanceTo(time);
    assert.equal(app.opens.length,15,'the deadline check must happen before another reopen');
    assert.equal(app.closeCount,14);
    assert.equal(app.requestCount,1);
    assert.equal((await app.inspect()).connected,true,'timeout stops scanning without disconnecting');
  });

test('translating a D1 command while physically connected cannot write UART or change device and handshake',
  {timeout:3000,concurrency:false},async context=>{
    const app=await appHarness(context);
    app.element('protocol-mode').value='s21';
    app.fire('protocol-mode','change');
    const connecting=app.connect();
    app.request.resolve(app.port);
    await connecting;
    await app.push([0x02,0x46,0x31,0x77,0x03]);
    await app.push([0x06]);
    const before=await app.inspect();
    assert.equal(before.connected,true);
    assert.equal(before.device.saId,'s21');
    assert.equal(before.device.services.find(service=>service.id===0).raw,0);
    assert.equal(before.device.services.find(service=>service.id===3).raw,52);
    assert.equal(app.element('handshake-state').textContent,'握手已確認（ACK）');
    const handshakeText=app.element('handshake-state').textContent;
    const handshakeEvidence=app.element('handshake-evidence').textContent;
    const writesBefore=structuredClone(app.writes);
    assert.equal(writesBefore.length,1,'the mock UART observed the real F1 reply');
    assert.equal(writesBefore[0][0],0x06);
    assert.equal(writesBefore[0][1],0x02);

    // This valid setting would turn the current device on and lower its 26 C
    // target to 25 C if it accidentally reached the simulation engine.
    app.element('translator-input').value='RX: 02 44 31 31 33 4E 41 68 03';
    app.fire('translator-input','input');
    app.fire('translator-run');
    await settle();
    assert.equal(Number(app.element('translator-total').textContent),1);
    assert.equal(Number(app.element('translator-valid').textContent),1);
    assert.match(app.element('translator-results').innerHTML,/S21 D1.*開機.*25 °C/);
    assert.match(app.element('translator-notice').textContent,/已轉譯 1 筆/);

    const after=await app.inspect();
    assert.equal(after.connected,true);
    assert.deepEqual(after.device,before.device,'translation cannot execute the D1 setting');
    assert.deepEqual(app.writes,writesBefore,'translation cannot transmit a serial command or ACK');
    assert.deepEqual(after.discovery,before.discovery,'translation cannot alter handshake evidence');
    assert.equal(app.element('handshake-state').textContent,handshakeText);
    assert.equal(app.element('handshake-evidence').textContent,handshakeEvidence);
    assert.deepEqual(after.counts,before.counts,'translation is not simulator RX/TX traffic');
    assert.deepEqual(after.records,before.records);
  });
