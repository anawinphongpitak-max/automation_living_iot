/**
 * ทดสอบปุ่มสลับ Manual / Automation mode โดยไม่ต้องเปิดเบราว์เซอร์
 *
 * ดึง setupModeToggle / renderModeToggle ออกจาก script.js มารันใน sandbox
 * พร้อม DOM + mqttClient ปลอม แล้วตรวจว่า:
 *   - เริ่มต้นเป็น MANUAL
 *   - กดแล้วยิง POST /api/auto/on แล้วสลับเป็น AUTO
 *   - backend ตอบ fail -> ไม่สลับ
 *   - ปุ่มถูก disable ระหว่างรอ backend
 *   - initial_state จาก backend อัปเดตปุ่มได้
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

const modeStateBlock = slice('// โหมดควบคุม - manual = สั่งเองจาก dashboard', 'let systemStatus');
const modeBlock = slice('function setupModeToggle()', '/* =====================================================\n   HELPER FUNCTIONS FOR SMART HOME OVERVIEW');

// ---------- DOM ปลอม ----------
const autoCalls = [];
const toasts = [];
const logs = [];
let clickHandler = null;

const button = {
  disabled: false,
  innerHTML: '',
  title: '',
  _classes: new Set(),
  classList: {
    toggle(name, on) {
      if (on) button._classes.add(name); else button._classes.delete(name);
    },
    contains: n => button._classes.has(n)
  },
  addEventListener(evt, fn) { if (evt === 'click') clickHandler = fn; }
};

let failNext = false;

const sandbox = {
  console: { log() {} },
  showToast: m => toasts.push(m),
  addLog: (room, text) => logs.push(text),
  mqttClient: {
    setAutoMode: async cmd => {
      autoCalls.push({ cmd, disabledWhileWaiting: button.disabled });
      return failNext ? { success: false, error: 'boom' } : { success: true };
    }
  },
  document: {
    getElementById: id => (id === 'modeToggle' ? button : null)
  }
};

vm.createContext(sandbox);
vm.runInContext(modeStateBlock, sandbox);
vm.runInContext(modeBlock, sandbox);
vm.runInContext('globalThis.__api = { setupModeToggle, renderModeToggle };', sandbox);
const api = sandbox.__api;
const mode = () => vm.runInContext('autoMode', sandbox);

(async () => {
  console.log('=== mode toggle (Manual / Automation) ===\n');

  // ---------- 1. ตั้งค่าเริ่มต้น ----------
  api.setupModeToggle();
  check('เริ่มต้นเป็น manual', mode(), false);
  check('  ปุ่มแสดง MANUAL', button.innerHTML.includes('MANUAL'), true);
  check('  ไอคอน pan_tool', button.innerHTML.includes('pan_tool'), true);
  check('  ไม่มี class auto', button.classList.contains('auto'), false);
  check('  bind click handler แล้ว', typeof clickHandler === 'function', true);

  // ---------- 2. กดสลับไป automation ----------
  await clickHandler();
  check('ยิง setAutoMode("on")', autoCalls.map(c => c.cmd), ['on']);
  check('  disable ปุ่มระหว่างรอ backend', autoCalls[0].disabledWhileWaiting, true);
  check('  ปลด disable หลังเสร็จ', button.disabled, false);
  check('  autoMode = true', mode(), true);
  check('  ปุ่มแสดง AUTO', button.innerHTML.includes('AUTO'), true);
  check('  ไอคอน smart_toy', button.innerHTML.includes('smart_toy'), true);
  check('  มี class auto', button.classList.contains('auto'), true);
  check('  toast แจ้ง automation', toasts.some(t => t.includes('Automation')), true);
  check('  log บันทึก', logs.includes('Switched to AUTOMATION mode'), true);

  // ---------- 3. กดสลับกลับ manual ----------
  await clickHandler();
  check('ยิง setAutoMode("off")', autoCalls.map(c => c.cmd), ['on', 'off']);
  check('  autoMode = false', mode(), false);
  check('  ปุ่มกลับเป็น MANUAL', button.innerHTML.includes('MANUAL'), true);
  check('  class auto ถูกถอด', button.classList.contains('auto'), false);
  check('  log บันทึก', logs.includes('Switched to MANUAL mode'), true);

  // ---------- 4. backend ตอบ fail -> ไม่สลับ ----------
  failNext = true;
  toasts.length = 0;
  const before = mode();
  await clickHandler();
  check('backend fail -> โหมดไม่เปลี่ยน', mode(), before);
  check('  toast แจ้ง error', toasts.some(t => t.includes('ไม่สำเร็จ')), true);
  check('  ปุ่มยังกดได้ต่อ', button.disabled, false);
  failNext = false;

  // ---------- 5. sync จาก backend (initial_state) ----------
  vm.runInContext('autoMode = true;', sandbox);
  api.renderModeToggle();
  check('sync จาก backend -> ปุ่มอัปเดต', button.innerHTML.includes('AUTO'), true);
  check('  class auto ถูกใส่', button.classList.contains('auto'), true);

  vm.runInContext('autoMode = false;', sandbox);
  api.renderModeToggle();
  check('sync กลับ manual -> ปุ่มอัปเดต', button.innerHTML.includes('MANUAL'), true);

  // ---------- 6. title เปลี่ยนตามโหมด ----------
  check('title บอกวิธีใช้', button.title.includes('Manual Mode'), true);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
