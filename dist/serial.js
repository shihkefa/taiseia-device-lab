// One writer per session. Reconfiguring reopens the already granted port;
// generation checks prevent a cancelled open or an old queue reviving a connection.
export class SerialTransport {
  constructor({onData=()=>{},onError=()=>{},onState=()=>{}}={}) {
    Object.assign(this,{onData,onError,onState});
    this.session=null; this.opening=false; this.generation=0;
  }
  get connected(){return Boolean(this.session?.active);}
  async connect(options,serial=globalThis.navigator?.serial) {
    if(this.session||this.opening)throw Error('串口已連線或正在連接');
    if(!serial)throw Error('此瀏覽器不支援 Web Serial，請使用桌面 Chrome 或 Edge');
    const generation=++this.generation; this.opening=true;
    try {
      const port=await serial.requestPort();
      if(generation!==this.generation)return false;
      return await this.openPort(port,serial,options,generation,false);
    } finally {this.opening=false;}
  }
  async openPort(port,serial,options,generation,reconfigured) {
    await port.open(options);
    if(generation!==this.generation){await port.close();return false;}
    let writer;
    try {writer=port.writable.getWriter();} catch(e){await port.close();throw e;}
    const s={port,serial,active:true,writer,reader:null,queue:Promise.resolve(),cancelDelay:null};
    this.session=s;
    s.disconnectHandler=event=>{if(event.target===port||event.port===port){this.onError(Error('串口裝置已移除'));void this.disconnect();}};
    serial.addEventListener?.('disconnect',s.disconnectHandler);
    this.onState(true,port.getInfo?.(),{reconfigured,options});
    s.readLoop=this.read(s);
    return true;
  }
  async reconfigure(options) {
    const s=this.session;
    if(!s?.active||this.opening)throw Error('串口無法切換參數');
    this.opening=true;
    const generation=++this.generation;
    try {
      await this.closeSession(s);
      if(generation!==this.generation)return false;
      return await this.openPort(s.port,s.serial,options,generation,true);
    } catch(e) {if(generation===this.generation)this.onState(false);throw e;}
    finally {this.opening=false;}
  }
  async read(s) {
    try {
      while(s.active&&s.port.readable) {
        const reader=s.port.readable.getReader();s.reader=reader;
        try {
          while(s.active) {
            const {value,done}=await reader.read();
            if(done||!s.active||this.session!==s)break;
            if(value?.length)this.onData(value);
          }
        } catch(e){if(s.active)this.onError(e);}
        finally {reader.releaseLock();s.reader=null;}
        if(s.active&&!s.port.readable)break;
      }
    } finally {
      if(s.active){this.onError(Error('串口讀取已結束'));queueMicrotask(()=>{if(this.session===s)void this.disconnect();});}
    }
  }
  send(bytes,delay=0,onSent=()=>{}) {
    const s=this.session;if(!s?.active)return Promise.reject(Error('尚未連接串口'));
    const copy=Uint8Array.from(bytes);
    const task=s.queue.then(async()=>{
      if(!s.active||this.session!==s)return false;
      if(delay>0)await new Promise(resolve=>{
        const timer=setTimeout(()=>{s.cancelDelay=null;resolve();},delay);
        s.cancelDelay=()=>{clearTimeout(timer);s.cancelDelay=null;resolve();};
      });
      if(!s.active||this.session!==s)return false;
      await s.writer.write(copy);
      if(s.active&&this.session===s)onSent(copy);
      return s.active&&this.session===s;
    });
    s.queue=task.catch(e=>{if(s.active){this.onError(e);queueMicrotask(()=>{if(this.session===s)void this.disconnect();});}});
    return task;
  }
  async closeSession(s) {
    if(s.closing)return s.closing;
    s.active=false;s.cancelDelay?.();
    s.closing=(async()=>{
      try{await s.reader?.cancel();}catch{}
      try{await s.readLoop;}catch{}
      try{await s.writer.abort();}catch{}
      await s.queue;
      try{s.writer.releaseLock();}catch{}
      try{await s.port.close();}catch(e){this.onError(e);}
      s.serial.removeEventListener?.('disconnect',s.disconnectHandler);
      if(this.session===s)this.session=null;
    })();
    return s.closing;
  }
  async disconnect() {
    ++this.generation;
    const s=this.session;
    if(s){s.active=false;s.cancelDelay?.();}
    this.onState(false);
    if(s)await this.closeSession(s);
  }
}
