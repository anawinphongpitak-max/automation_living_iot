/**
 * ทดสอบกับ backend + mock จริง: ปล่อยให้ status ไหลเข้ามาสักพัก
 * แล้วนับว่า frontend handler จะ log กี่ครั้ง
 *
 * ต่อ WS จริง เก็บ mqtt_message ทุกตัว แล้วป้อนเข้า applyRoomStatus
 * ตัวจริงจาก script.js เพื่อดูว่ามี log spam ไหม
 *
 * ต้องรัน backend + mock-esp32 ไว้ก่อน
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');

const source = fs.readFileSync(path.join(__dirname, '../frontend/script.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function slice(start, end) {
  const s = source.indexOf(start);
  const e = source.indexOf(end, s);
  if (s === -1 || e === -1) throw new Error(`ไม่พบ marker: ${start}`);
  return source.slice(s, e);
}

const logged = [];
const sandbox = {
  console: { log() {} },
  addLog: (room, text) => logged.push(`${room}:${text}`),
  deviceIcon: () => '<span>i</span>',
  rooms: {
    living:  { name: 'Living Room', devices: { ac: { state: true, level: 2 }, exhaust: { state: false }, light: { state: true } } },
    kitchen: { name: 'Kitchen', devices: { exhaust: { state: true }, light: { state: false }, curtain: { state: 'open' }, window: { state: 'closed' } } },
    bedroom: { name: 'Bedroom', devices: { ac: { state: true, level: 1 }, fan: { state: true }, light: { state: true }, curtain: { state: 'open' }, window: { state: 'closed' } } }
  }
};

vm.createContext(sandbox);
vm.runInContext(slice('// ห้องที่เคยได้รับ home/status/{room}', 'let systemStatus'), sandbox);
vm.runInContext(slice('/**\n * อัปเดตสถานะอุปกรณ์ในห้องจาก payload', 'function addLog('), sandbox);
vm.runInContext('globalThis.__apply = applyRoomStatus;', sandbox);
const apply = sandbox.__apply;

const WATCH_SECONDS = 22;
let statusCount = 0;

console.log(`=== ปล่อย status ไหล ${WATCH_SECONDS} วินาที ===\n`);

const ws = new WebSocket('ws://localhost:3000');

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type !== 'mqtt_message') return;
  if (!/^home\/status\/(living|kitchen|bedroom)$/.test(m.topic)) return;

  statusCount++;
  apply(m.topic.split('/')[2], m.payload);
});

ws.on('open', () => {
  setTimeout(() => {
    // หัก 3 ตัวแรก (replay ตอนต่อ WS = การ sync ห้องละครั้ง)
    const afterSync = Math.max(0, statusCount - 3);

    console.log(`  status ที่ได้รับ     : ${statusCount} ครั้ง`);
    console.log(`  (หลังหัก sync 3 ห้อง : ${afterSync} ครั้ง)`);
    console.log(`  addLog ถูกเรียก      : ${logged.length} ครั้ง`);
    if (logged.length) {
      console.log(`  ข้อความ              : ${JSON.stringify(logged)}`);
    }

    const ok = statusCount > 3 && logged.length === 0;
    console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  ${ok
      ? 'ไม่มี log spam - สถานะไม่เปลี่ยนจึงไม่ขึ้น log'
      : (statusCount <= 3 ? 'ได้ status น้อยเกินไป (mock รันอยู่ไหม?)' : `มี log ${logged.length} ครั้งที่ไม่ควรมี`)}`);

    ws.close();
    process.exit(ok ? 0 : 1);
  }, WATCH_SECONDS * 1000);
});

ws.on('error', e => { console.error('WS error:', e.message); process.exit(1); });
