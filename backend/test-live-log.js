/**
 * ทดสอบ live log logic โดยไม่ต้องเปิดเบราว์เซอร์
 *
 * ดึงฟังก์ชัน addLog / renderLogs / logItemsHTML / shouldLogMotion ออกจาก
 * script.js มารันใน sandbox พร้อม DOM ปลอม แล้วตรวจว่า:
 *   - renderLogs() หา container ด้วย id ที่ถูก (dashboard-log-container)
 *   - addLog() เขียน HTML ลง container จริง
 *   - dedup PIR กันซ้ำใน 30 วินาที แต่ไม่กันห้องอื่น
 *   - เก็บแค่ 8 รายการล่าสุด
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '../frontend/script.js');
const source = fs.readFileSync(SCRIPT, 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n          got:      ${JSON.stringify(actual)}\n          expected: ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

// ---------- ดึงเฉพาะส่วนที่ต้องทดสอบออกมา ----------
function extract(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  if (s === -1) throw new Error(`ไม่พบ: ${startMarker}`);
  const e = source.indexOf(endMarker, s);
  if (e === -1) throw new Error(`ไม่พบ end: ${endMarker}`);
  return source.slice(s, e);
}

const logBlock = extract(
  '// PIR แจ้งซ้ำได้ไม่เกิน 1 ครั้ง/30 วินาทีต่อห้อง',
  '/* ====================================================='
);

// ---------- DOM ปลอม ----------
const container = { id: 'dashboard-log-container', innerHTML: '' };

const sandbox = {
  console: { log() {} },
  logs: [],
  rooms: {
    living:  { name: 'Living Room' },
    kitchen: { name: 'Kitchen' },
    bedroom: { name: 'Bedroom' }
  },
  document: {
    getElementById: id => (id === 'dashboard-log-container' ? container : null)
  },
  Date
};

vm.createContext(sandbox);
vm.runInContext(logBlock, sandbox);
vm.runInContext('globalThis.__api = { addLog, renderLogs, logItemsHTML, shouldLogMotion };', sandbox);
const api = sandbox.__api;

console.log('=== live log logic ===\n');

// 1. ตอนยังไม่มี log
check('ว่างเปล่า -> แสดง Waiting for events',
  api.logItemsHTML().includes('Waiting for events...'), true);

// 2. addLog เขียนลง container จริง (ข้อ 1 + 3 ที่แก้ไป)
api.addLog('kitchen', 'Motion Detected', '<span>walk</span>');
check('addLog เขียนลง container', container.innerHTML.includes('Motion Detected'), true);
check('  แสดงชื่อห้องถูก', container.innerHTML.includes('Kitchen'), true);
check('  logs มี 1 รายการ', sandbox.logs.length, 1);

// 3. roomId ที่ไม่รู้จัก -> System
api.addLog('nonexistent', 'Scene HOME', '<span>scene</span>');
check('ห้องไม่รู้จัก -> System', container.innerHTML.includes('System'), true);

// 4. เรียงใหม่สุดอยู่บน
check('รายการใหม่สุดอยู่บน', sandbox.logs[0].text, 'Scene HOME');

// 5. เก็บแค่ 8 รายการ
for (let i = 0; i < 15; i++) api.addLog('living', `event ${i}`, '<span>x</span>');
check('เก็บแค่ 8 รายการล่าสุด', sandbox.logs.length, 8);
check('  รายการบนสุดคืออันล่าสุด', sandbox.logs[0].text, 'event 14');

// 6. dedup PIR - ห้องเดียวกันยิงติดกัน
const first  = api.shouldLogMotion('living');
const second = api.shouldLogMotion('living');
const third  = api.shouldLogMotion('living');
check('PIR ครั้งแรก -> ผ่าน', first, true);
check('PIR ครั้งที่ 2 (ทันที) -> ถูกกัน', second, false);
check('PIR ครั้งที่ 3 (ทันที) -> ถูกกัน', third, false);

// 7. dedup แยกตามห้อง ไม่กันข้ามห้อง
check('ห้องอื่น (kitchen) -> ผ่าน', api.shouldLogMotion('kitchen'), true);
check('ห้องอื่น (bedroom) -> ผ่าน', api.shouldLogMotion('bedroom'), true);
check('kitchen ยิงซ้ำ -> ถูกกัน', api.shouldLogMotion('kitchen'), false);

// 8. หมด cooldown แล้วต้องผ่านอีก
vm.runInContext("lastMotionLog['living'] = Date.now() - 31000;", sandbox);
check('พ้น 30 วินาที -> ผ่านอีกครั้ง', api.shouldLogMotion('living'), true);

// 9. renderLogs หา container ด้วย id ที่ถูก
container.innerHTML = '';
api.renderLogs();
check('renderLogs เขียน container ได้ (id ถูก)', container.innerHTML.length > 0, true);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
