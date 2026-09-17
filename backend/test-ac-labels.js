/**
 * ทดสอบว่าเปลี่ยนแค่ชื่อที่แสดงบนปุ่มแอร์ ไม่กระทบ level ที่ส่งให้ backend
 *
 * ดึง AC_LEVEL_LABELS / acLevelLabel / deviceStatus ออกจาก script.js
 * มาตรวจ แล้วเช็คว่า HTML ที่ render ยังส่ง data-level 1/2/3 เหมือนเดิม
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '../frontend/script.js');
const source = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

function slice(start, end) {
  const s = source.indexOf(start);
  if (s === -1) throw new Error(`ไม่พบ: ${start}`);
  const e = source.indexOf(end, s);
  if (e === -1) throw new Error(`ไม่พบ end: ${end}`);
  return source.slice(s, e);
}

// ---------- โหลด label helper + deviceStatus ----------
const labelBlock = slice('// ชื่อที่แสดงบนปุ่มแอร์', '/* =====================================================\n   DEVICE STATUS');
const statusBlock = slice('function deviceStatus(device)', '/* =====================================================');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(labelBlock, sandbox);
vm.runInContext(statusBlock, sandbox);
vm.runInContext('globalThis.__api = { acLevelLabel, AC_LEVEL_LABELS, deviceStatus };', sandbox);
const { acLevelLabel, AC_LEVEL_LABELS, deviceStatus } = sandbox.__api;

console.log('=== AC level labels ===\n');

// ---------- 1. mapping ตรงตามที่สั่ง ----------
check('level 1 -> SLEEP', acLevelLabel(1), 'SLEEP');
check('level 2 -> COOL', acLevelLabel(2), 'COOL');
check('level 3 -> COOLER', acLevelLabel(3), 'COOLER');
check('level 0 -> OFF', acLevelLabel(0), 'OFF');
check('index ตรงกับ level (array ยาว 4)', AC_LEVEL_LABELS.length, 4);

// ---------- 2. ค่าแปลกๆ ไม่พัง ----------
check('level undefined -> OFF', acLevelLabel(undefined), 'OFF');
check('level 9 -> OFF', acLevelLabel(9), 'OFF');
check('level null -> OFF', acLevelLabel(null), 'OFF');

// ---------- 3. deviceStatus (การ์ดย่อ) ----------
check('deviceStatus ปิด -> OFF',
  deviceStatus({ type: 'ac', state: false, level: 2 }), 'OFF');
check('deviceStatus lv1 -> SLEEP',
  deviceStatus({ type: 'ac', state: true, level: 1 }), 'SLEEP');
check('deviceStatus lv3 -> COOLER',
  deviceStatus({ type: 'ac', state: true, level: 3 }), 'COOLER');
check('  ไม่เหลือรูปแบบ L2 เดิม',
  deviceStatus({ type: 'ac', state: true, level: 2 }).startsWith('L'), false);

// ---------- 4. HTML ปุ่ม: label เปลี่ยน แต่ data-level เดิม ----------
// ดึง deviceCard() มาทั้งฟังก์ชัน แล้วเรียกจริงกับการ์ดแอร์
const cardFn = slice('function deviceCard(roomId, deviceId, device)', '/* =====================================================\n   DEVICE ICON');

const htmlSandbox = { acLevelLabel, deviceStatus, deviceIcon: () => '<span>i</span>' };
vm.createContext(htmlSandbox);
vm.runInContext(cardFn, htmlSandbox);
vm.runInContext('globalThis.__f = deviceCard;', htmlSandbox);

const html = htmlSandbox.__f('living', 'ac', {
  name: 'Air Conditioner', type: 'ac', state: true, level: 2
});

check('ปุ่มแสดง SLEEP', html.includes('SLEEP'), true);
check('ปุ่มแสดง COOL', html.includes('COOL'), true);
check('ปุ่มแสดง COOLER', html.includes('COOLER'), true);
check('ไม่มีคำว่า "LEVEL 1" แล้ว', /LEVEL\s+1/.test(html), false);
check('ไม่มีข้อความ "3-level control"', html.includes('3-level control'), false);
check('  เปลี่ยนเป็น "3-mode control"', html.includes('3-mode control'), true);

// สำคัญที่สุด: ค่าที่ส่งให้ backend ต้องไม่เปลี่ยน
check('data-level="1" ยังอยู่', html.includes('data-level="1"'), true);
check('data-level="2" ยังอยู่', html.includes('data-level="2"'), true);
check('data-level="3" ยังอยู่', html.includes('data-level="3"'), true);
check('  ไม่มี data-level เป็นชื่อโหมด', /data-level="(SLEEP|COOL|COOLER)"/.test(html), false);
check('สถานะการ์ดแสดง "● ON · COOL"', html.includes('● ON · COOL'), true);

// ---------- 5. ปุ่ม active ตรงกับ level ที่เปิดอยู่ ----------
const activeBtn = /<button\s+class="ac-level active"[\s\S]*?data-level="(\d)"/.exec(html);
check('ปุ่มที่ active คือ level 2 (COOL)', activeBtn && activeBtn[1], '2');

const offHtml = htmlSandbox.__f('bedroom', 'ac', {
  name: 'Air Conditioner', type: 'ac', state: false, level: 1
});
check('แอร์ปิด -> แสดง "○ OFF"', offHtml.includes('○ OFF'), true);
check('  ไม่มีปุ่มไหน active', /class="ac-level active"/.test(offHtml), false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
