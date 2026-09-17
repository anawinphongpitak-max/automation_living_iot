/**
 * ทดสอบ door lock + นับถอยหลัง 5 วินาที โดยไม่ต้องเปิดเบราว์เซอร์
 *
 * ดึง doorLockCardHTML / unlockDoor / refreshDoorCard ออกจาก script.js
 * มารันใน sandbox พร้อม DOM + mqttClient ปลอม แล้วเร่งเวลาด้วย fake timer
 * เพื่อตรวจว่า:
 *   - กดปุ่มแล้วยิง POST /api/door/unlock
 *   - นับ 5 -> 1 แล้วยิง lock อัตโนมัติ
 *   - กดซ้ำระหว่างนับไม่ทำอะไร
 *   - ESP32 ล็อคเองระหว่างนับ -> ยกเลิกตัวนับ
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '../frontend/script.js');
// script.js ใช้ CRLF - normalize เป็น LF ก่อน ไม่งั้น marker หลายบรรทัดจะไม่แมตช์
const source = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n          got:      ${JSON.stringify(actual)}\n          expected: ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

function slice(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  if (s === -1) throw new Error(`ไม่พบ: ${startMarker}`);
  const e = source.indexOf(endMarker, s);
  if (e === -1) throw new Error(`ไม่พบ end: ${endMarker}`);
  return source.slice(s, e);
}

// ---------- ดึงโค้ดที่ต้องทดสอบ ----------
const doorStateBlock = slice('// สถานะประตู - locked มาจาก', 'let systemStatus');
const doorCardBlock = slice('/* =====================================================\n   DOOR LOCK CARD', '/* =====================================================\n   ROOM DASHBOARD CARD');

// ---------- fake timers ----------
let fakeNow = 0;
const timers = [];
function fakeSetInterval(fn, ms) {
  const t = { fn, ms, next: fakeNow + ms, active: true };
  timers.push(t);
  return t;
}
function fakeClearInterval(t) { if (t) t.active = false; }
/** เดินเวลาไปข้างหน้า แล้วรอ promise ที่ค้างอยู่ให้เสร็จ */
async function tick(ms) {
  const target = fakeNow + ms;
  while (fakeNow < target) {
    fakeNow += 1000;
    for (const t of timers) {
      if (t.active && fakeNow >= t.next) {
        t.next = fakeNow + t.ms;
        await t.fn();
      }
    }
    await new Promise(r => setImmediate(r));
  }
}

// ---------- DOM ปลอม ----------
let cardEl = { className: 'card door-lock-card', outerHTML: '', replaced: 0 };
const doorCalls = [];
const toasts = [];
const logLines = [];

const sandbox = {
  console: { log() {} },
  currentPage: 'dashboard',
  rooms: {},
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  showToast: m => toasts.push(m),
  addLog: (room, text) => logLines.push(text),
  mqttClient: {
    controlDoor: async cmd => { doorCalls.push(cmd); return { success: true }; }
  },
  document: {
    querySelector: sel => (sel === '.door-lock-card' ? cardEl : null),
    createElement: () => {
      const el = { _html: '' };
      Object.defineProperty(el, 'innerHTML', {
        set(v) { this._html = v; },
        get() { return this._html; }
      });
      Object.defineProperty(el, 'firstElementChild', {
        get() {
          return {
            className: 'card door-lock-card',
            outerHTML: el._html,
            replaceWith(n) { cardEl = n; }
          };
        }
      });
      return el;
    }
  }
};
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(doorStateBlock, sandbox);
vm.runInContext(doorCardBlock, sandbox);
vm.runInContext('globalThis.__api = { doorLockCardHTML, unlockDoor, refreshDoorCard };', sandbox);
const api = sandbox.__api;

// `let doorState` เป็น lexical declaration ใน vm context จึงไม่ผูกกับ sandbox
// object ต้องอ่านผ่าน runInContext
const door = () => vm.runInContext('doorState', sandbox);

// ให้ refreshDoorCard เขียนผลลง cardEl ที่เราตรวจได้
cardEl.replaceWith = n => { cardEl = n; };

(async () => {
  console.log('=== door lock + countdown ===\n');

  // 1. สถานะเริ่มต้น
  check('เริ่มต้น locked', door().locked, true);
  let html = api.doorLockCardHTML();
  check('  แสดง SECURED', html.includes('SECURED'), true);
  check('  ไอคอน lock', html.includes('>\n                        lock\n'), true);
  check('  ปุ่มกดได้ (ไม่ disabled)', html.includes('disabled'), false);

  // 2. กดปลดล็อค
  await api.unlockDoor();
  check('ยิง controlDoor(unlock)', doorCalls, ['unlock']);
  check('  locked = false', door().locked, false);
  check('  ตั้งเวลา 5 วินาที', door().unlockSecondsLeft, 5);
  check('  toast ปลดล็อค', toasts.some(t => t.includes('ปลดล็อค')), true);
  check('  log UNLOCKED', logLines.includes('Door UNLOCKED'), true);

  html = api.doorLockCardHTML();
  check('  แสดง UNLOCKED', html.includes('UNLOCKED'), true);
  check('  ปุ่มถูก disable ระหว่างนับ', html.includes('disabled'), true);
  check('  แสดงเลข 5', html.includes('>5<'), true);

  // 3. กดซ้ำระหว่างนับ - ต้องไม่ยิงอะไรเพิ่ม
  await api.unlockDoor();
  check('กดซ้ำระหว่างนับ -> ไม่ยิงซ้ำ', doorCalls, ['unlock']);

  // 4. เดินเวลา 3 วินาที
  await tick(3000);
  check('ผ่าน 3 วินาที -> เหลือ 2', door().unlockSecondsLeft, 2);
  check('  ยังไม่ล็อค', door().locked, false);

  // 5. เดินครบ 5 วินาที -> ล็อคอัตโนมัติ
  await tick(2000);
  check('ครบ 5 วินาที -> ยิง lock', doorCalls, ['unlock', 'lock']);
  check('  locked = true', door().locked, true);
  check('  timer ถูกเคลียร์', door().unlockTimer, null);
  check('  toast ล็อคอัตโนมัติ', toasts.some(t => t.includes('อัตโนมัติ')), true);
  check('  log LOCKED (auto)', logLines.includes('Door LOCKED (auto)'), true);

  // 6. ไม่นับต่อหลังหมดเวลา
  await tick(3000);
  check('ไม่ยิงเพิ่มหลังหมดเวลา', doorCalls, ['unlock', 'lock']);

  // 7. กดใหม่ได้อีกครั้ง
  await api.unlockDoor();
  check('กดใหม่ได้', doorCalls, ['unlock', 'lock', 'unlock']);
  check('  นับใหม่จาก 5', door().unlockSecondsLeft, 5);

  // 8. ESP32 ล็อคเองระหว่างนับ -> ยกเลิกตัวนับ
  //    (จำลอง branch home/status/door ที่ set locked แล้วเคลียร์ timer)
  vm.runInContext(`
    doorState.locked = true;
    if (doorState.unlockTimer) {
      clearInterval(doorState.unlockTimer);
      doorState.unlockTimer = null;
      doorState.unlockSecondsLeft = 0;
    }
  `, sandbox);
  check('ESP32 ล็อคเอง -> timer ถูกยกเลิก', door().unlockTimer, null);
  check('  ตัวนับรีเซ็ต', door().unlockSecondsLeft, 0);

  const before = doorCalls.length;
  await tick(6000);
  check('  ไม่ยิง lock ซ้ำหลังยกเลิก', doorCalls.length, before);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
