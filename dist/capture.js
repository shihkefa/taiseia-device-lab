export class Capture{
  constructor(limit=5000){this.limit=limit;this.records=[];this.nextId=1;this.dropped=0;this.counts={RX:0,TX:0,error:0};}
  add(record){const entry={id:this.nextId++,timestamp:new Date().toISOString(),monotonicMs:performance.now(),...record,bytes:Array.from(record.bytes||[])};if(entry.kind==='frame'&&entry.direction in this.counts)this.counts[entry.direction]++;if(entry.error)this.counts.error++;this.records.push(entry);if(this.records.length>this.limit){this.records.shift();this.dropped++;}return entry;}
  clear(){this.records=[];this.dropped=0;this.counts={RX:0,TX:0,error:0};}
  csv(){const columns=['id','timestamp','monotonicMs','direction','source','protocol','kind','profileRevision','hex','description','error','requestId','latencyMs'];const q=v=>'"'+String(v??'').replaceAll('"','""')+'"';return '\uFEFF'+[columns.join(','),...this.records.map(r=>columns.map(k=>q(k==='hex'?r.bytes.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' '):r[k])).join(','))].join('\r\n');}
}
