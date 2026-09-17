/**
 * ตรวจว่าการ์ด live log ถูกล็อคความสูง ไม่ยืดตามจำนวน log
 *
 * อ่านค่าจาก style.css จริง + ตรวจว่า logItemsHTML() ยัง cap ที่ 8 รายการ
 * (เช็คแบบ static เพราะไม่มี browser engine ในเครื่อง)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '../frontend');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(path.join(DIR, 'script.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

/** ดึง body ของ rule ตัวแรกที่ selector ตรง (นอก @media) */
function rule(selector) {
  const esc = selector.replace(/[.#]/g, m => '\\' + m);
  const re = new RegExp(`(?:^|[^\\w.#-])${esc}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  return m ? m[1] : null;
}

const prop = (body, name) => {
  const m = new RegExp(`(?:^|;|\\s)${name}:\\s*([^;]+);`).exec(body || '');
  return m ? m[1].trim() : null;
};

console.log('=== live log: ล็อคขนาดการ์ด ===\n');

// ---------- การ์ด ----------
const card = rule('.live-log-card');
check('มี rule .live-log-card', card !== null, true);
check('  overflow: hidden (ตัด log ที่เกิน)', prop(card, 'overflow'), 'hidden');
check('  เป็น flex column', [prop(card, 'display'), prop(card, 'flex-direction')], ['flex', 'column']);
check('  มี min-height กันการ์ดแบน', prop(card, 'min-height'), '300px');
check('  ไม่มี height ตายตัว (ยืดเท่าแถวได้)', prop(card, 'height'), null);

// ---------- container ----------
const box = rule('#dashboard-log-container');
check('มี rule #dashboard-log-container', box !== null, true);
check('  height: 0 (เนื้อหาไม่ดัน grid row)', prop(box, 'height'), '0');
check('  flex: 1 1 0 (กินพื้นที่ที่เหลือ)', prop(box, 'flex'), '1 1 0');
check('  min-height: 0 (flex ยอมให้หดได้)', prop(box, 'min-height'), '0');
check('  overflow: hidden', prop(box, 'overflow'), 'hidden');
check('  มี mask ไล่เฟดขอบล่าง', /mask-image:\s*linear-gradient/.test(box), true);

// ---------- log ring ----------
check('logs cap ที่ 8 รายการ', /logs\.slice\(0,\s*8\)/.test(js), true);

// ---------- logItemsHTML ยังทำงาน ----------
const s = js.indexOf('function logItemsHTML()');
const e = js.indexOf('function renderLogs()');
const sandbox = { logs: [] };
vm.createContext(sandbox);
vm.runInContext(js.slice(s, e), sandbox);
vm.runInContext('globalThis.__f = logItemsHTML;', sandbox);
const render = sandbox.__f;

check('ว่าง -> Waiting for events', render().includes('Waiting for events'), true);

// ป้อน 8 รายการ (เต็ม ring)
sandbox.logs.push(...Array.from({ length: 8 }, (_, i) => ({
  time: '12:00:0' + i, icon: '<span>i</span>', text: 'event ' + i, room: 'Living Room'
})));
const html = render();
const count = html.split('class="log-item"').length - 1;
check('8 รายการ -> render 8 log-item', count, 8);
check('  ไม่มี inline height/style ที่ทำให้ยืด', /style="[^"]*height/.test(html), false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
