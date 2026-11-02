// TaiXia taixia.h + switch/taixia_switch.cpp: both beeper values are inverted.
// Only these public SA/service mappings establish a buzzer; a name alone does not.
const BUZZER_IDS={1:30,4:24};
export function getBuzzerStatus(profile){
  if(!profile||profile.protocol&&profile.protocol!=='taiseia'||!Object.hasOwn(BUZZER_IDS,profile.saId))return null;
  const id=BUZZER_IDS[profile.saId],service=profile.services?.find(s=>s.id===id);if(!service)return null;
  if(!service.enabled)return {id,state:'unavailable',text:'未提供'};
  return {id,state:service.raw===0?'on':service.raw===1?'off':'unknown',text:service.raw===0?'開啟':service.raw===1?'關閉':service.raw===65535?'未知（FFFF）':'未知值 '+service.raw};
}
