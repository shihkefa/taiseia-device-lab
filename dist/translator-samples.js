// Synthetic TaiSEIA examples, not hardware captures. Each SA has its own IDs.
import {frame,hex} from './protocol.js?v=1.3.9';
const examples={
  1:{name:'空調',read:[3,26],write:[0,1],status:[[0,1],[3,26],[4,28],[36,23]]},
  3:{name:'洗衣機',read:[2,10],write:[0,1],status:[[0,1],[2,10],[26,23],[30,123]]},
  4:{name:'除濕機',read:[3,55],write:[3,55],status:[[0,1],[3,55],[6,27],[7,65]]},
  8:{name:'空氣清淨機',read:[1,3],write:[8,1],status:[[0,1],[1,3],[8,1],[13,120]]},
  14:{name:'全熱交換器',read:[21,1],write:[21,1],status:[[0,1],[1,3],[21,1],[22,2]]},
  15:{name:'電風扇',read:[2,5],write:[5,1],status:[[0,1],[2,5],[5,1],[11,60]]},
};
export function taiTranslationSample(deviceId=1){
  const id=Object.hasOwn(examples,deviceId)?Number(deviceId):1,s=examples[id];
  const request=frame(id,s.write[0]|128,s.write[1]);
  const rows=[
    ['RX',frame(0,4,65535)],['TX',frame(0,4,id)],
    ['RX',frame(id,s.read[0],65535)],['TX',frame(id,...s.read)],
    ['RX',request],['TX',request],
    ['TX',frame(0,8,s.status.flatMap(([sid,raw])=>[sid,raw>>>8,raw&255]))]
  ];
  return {deviceId:id,name:s.name,text:rows.map(([direction,b])=>direction+': '+hex(b)).join('\n')};
}
