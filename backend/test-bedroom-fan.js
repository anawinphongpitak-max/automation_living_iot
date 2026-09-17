/**
 * ทดสอบว่า backend เติม exhaustFan ให้ payload ห้องนอน และ frontend
 * จะอ่านสถานะพัดลมได้ (script.js:4507 เช็ค exhaustFan ก่อนอัปเดต)
 *
 * ต่อ WS รอ mqtt_message ของ home/status/bedroom แล้วตรวจ payload
 */
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');
let checked = false;

ws.on('open', () => console.log('WS connected, waiting for home/status/bedroom...\n'));

ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== 'mqtt_message' || msg.topic !== 'home/status/bedroom') return;
  if (checked) return;
  checked = true;

  const p = msg.payload;
  console.log('payload:', JSON.stringify(p));

  const hasFan = p.fan !== undefined;
  const hasMirror = p.exhaustFan !== undefined;
  const consistent = !hasFan || p.exhaustFan === p.fan;

  console.log(`\n  fan field present        : ${hasFan ? 'yes' : 'no'}`);
  console.log(`  exhaustFan mirror added  : ${hasMirror ? 'yes' : 'NO'}`);
  console.log(`  mirror matches fan       : ${consistent ? 'yes' : 'NO'}`);
  console.log(`\n${hasMirror && consistent ? 'PASS' : 'FAIL'} - frontend ${hasMirror ? 'will' : 'will NOT'} update bedroom fan`);

  ws.close();
  process.exit(hasMirror && consistent ? 0 : 1);
});

ws.on('error', e => { console.error('WS error:', e.message); process.exit(1); });

setTimeout(() => {
  console.error('timeout - no home/status/bedroom received (ESP32 offline?)');
  process.exit(1);
}, 12000);
