/**
 * ตรวจว่า grid layout ของ dashboard ลงตัวทุก breakpoint
 * และการ์ด door lock อยู่แถวแรกถัดจาก hero ใน DOM
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../frontend');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(path.join(DIR, 'script.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

/** ดึงบล็อก @media (หรือ base ถ้าไม่ระบุ) แล้วหา grid-column ของ selector */
function scope(mediaQuery) {
  if (!mediaQuery) {
    const firstMedia = css.indexOf('@media');
    return css.slice(0, firstMedia === -1 ? css.length : firstMedia);
  }
  const start = css.indexOf(mediaQuery);
  if (start === -1) throw new Error(`ไม่พบ ${mediaQuery}`);
  // หาปีกกาปิดของ @media ด้วยการนับ depth
  let depth = 0, i = css.indexOf('{', start);
  const open = i;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) break; }
  }
  return css.slice(open, i);
}

/** อ่านค่า grid-column ของ selector ตัวสุดท้ายที่เจอใน scope */
function span(text, selector) {
  // selector อาจนำหน้าด้วย */ (ปิดคอมเมนต์), { } , หรือขึ้นบรรทัดใหม่
  // จึงเช็คแค่ว่าตัวหน้าไม่ใช่อักขระที่ต่อกับชื่อ class ได้
  const esc = selector.replace('.', '\\.');
  const re = new RegExp(`(?:^|[^\\w.-])${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g');
  let m, last = null;
  while ((m = re.exec(text)) !== null) {
    const decl = /grid-column:\s*([^;]+);/.exec(m[1]);
    if (decl) last = decl[1].trim();
  }
  // เผื่อ selector อยู่ท้ายกลุ่ม (.a, .b { ... })
  if (last === null) {
    const grouped = new RegExp(`[^{}]*,\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
    while ((m = grouped.exec(text)) !== null) {
      const decl = /grid-column:\s*([^;]+);/.exec(m[1]);
      if (decl) last = decl[1].trim();
    }
  }
  return last;
}

function columns(text) {
  const m = /\.dashboard-grid\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(text);
  if (!m) return null;
  const r = /repeat\(\s*(\d+)/.exec(m[1]);
  return r ? Number(r[1]) : m[1].trim();
}

console.log('=== dashboard grid layout ===\n');

// ---------- base (จอกว้าง) ----------
const base = scope(null);
check('base: grid 12 คอลัมน์', columns(base), 12);
check('  hero-card span 10', span(base, '.hero-card'), 'span 10');
check('  door-lock-card span 2', span(base, '.door-lock-card'), 'span 2');

const heroBase = /\.hero-card\s*\{([^}]*)\}/.exec(base)[1];
const doorBase = /\.door-lock-card\s*\{([^}]*)\}/.exec(base)[1];
const heroH = /min-height:\s*([^;]+);/.exec(heroBase)?.[1].trim();
const doorH = /min-height:\s*([^;]+);/.exec(doorBase)?.[1].trim();
check('  ความสูงเท่ากัน (240px)', [heroH, doorH], ['240px', '240px']);
check('  10 + 2 = 12 พอดี', 10 + 2, 12);

// ---------- 1400px ----------
const m1400 = scope('@media(max-width:1400px)');
check('1400px: grid 6 คอลัมน์', columns(m1400), 6);
check('  hero span 5', span(m1400, '.hero-card'), 'span 5');
check('  door span 1', span(m1400, '.door-lock-card'), 'span 1');
check('  5 + 1 = 6 พอดี', 5 + 1, 6);

// ---------- 1100px ----------
const m1100 = scope('@media(max-width:1100px)');
check('1100px: grid 3 คอลัมน์', columns(m1100), 3);
check('  hero span 2', span(m1100, '.hero-card'), 'span 2');
check('  door span 1', span(m1100, '.door-lock-card'), 'span 1');
check('  2 + 1 = 3 พอดี', 2 + 1, 3);

// ---------- 760px ----------
const m760 = scope('@media(max-width:760px)');
check('760px: grid 1 คอลัมน์', columns(m760), '1fr');
check('  door span 1 (เต็มแถว)', span(m760, '.door-lock-card'), '1');
check('  กลับมาเรียงแนวนอน', /\.door-lock-body\s*\{[^}]*flex-direction:\s*row/.test(m760), true);

// ---------- ลำดับใน DOM ----------
const heroPos = js.indexOf('<div class="card hero-card">');
const doorPos = js.indexOf('${doorLockCardHTML()}');
const livingPos = js.indexOf('${roomDashboardCard("living")}');
const logPos = js.indexOf('<div class="card live-log-card">');

check('DOM: hero มาก่อน door', heroPos < doorPos, true);
check('  door มาก่อน living room', doorPos < livingPos, true);
check('  door ไม่ได้อยู่ท้ายสุดแล้ว', doorPos < logPos, true);
check('  มี doorLockCardHTML() ครั้งเดียว',
  js.split('${doorLockCardHTML()}').length - 1, 1);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
