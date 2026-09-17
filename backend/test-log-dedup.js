/**
 * ทดสอบว่า live log ขึ้นเฉพาะเมื่อสถานะเปลี่ยน ไม่ใช่ทุกครั้งที่ได้ status
 *
 * จำลอง firmware ที่ publish home/status/{room} ทุก 5 วินาที ด้วย payload
 * เดิมซ้ำๆ แล้วตรวจว่า addLog ถูกเรียกกี่ครั้ง
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

const syncedBlock = slice('// ห้องที่เคยได้รับ home/status/{room}', 'let systemStatus');
const applyBlock = slice('/**\n * อัปเดตสถานะอุปกรณ์ในห้องจาก payload', 'function addLog(');
// applyRoomStatus เรียก acLevelLabel ด้วย (ในเบราว์เซอร์เป็น global ตัวเดียวกัน)
const labelBlock = slice('// ชื่อที่แสดงบนปุ่มแอร์', '/* =====================================================\n   DEVICE STATUS');

const logged = [];

const sandbox = {
  console: { log() {} },
  addLog: (room, text) => logged.push(`${room}:${text}`),
  deviceIcon: () => '<span>i</span>',
  rooms: {
    living: {
      name: 'Living Room',
      devices: {
        ac: { type: 'ac', state: true, level: 2 },
        exhaust: { type: 'fan', state: false },
        light: { type: 'light', state: true }
      }
    },
    kitchen: {
      name: 'Kitchen',
      devices: {
        exhaust: { type: 'fan', state: true },
        light: { type: 'light', state: false },
        window: { type: 'servo', state: 'closed' }
      }
    },
    bedroom: {
      name: 'Bedroom',
      devices: {
        ac: { type: 'ac', state: true, level: 1 },
        fan: { type: 'fan', state: true },
        light: { type: 'light', state: true },
        window: { type: 'servo', state: 'closed' }
      }
    }
  }
};

vm.createContext(sandbox);
vm.runInContext(labelBlock, sandbox);
vm.runInContext(syncedBlock, sandbox);
vm.runInContext(applyBlock, sandbox);
vm.runInContext('globalThis.__apply = applyRoomStatus;', sandbox);
const apply = sandbox.__apply;
const rooms = sandbox.rooms;

// `const syncedRooms` เป็น lexical declaration ใน vm context จึงไม่ผูกกับ
// sandbox object ต้องอ่านผ่าน runInContext
const synced = () => vm.runInContext('syncedRooms', sandbox);

console.log('=== live log: เฉพาะเมื่อสถานะเปลี่ยน ===\n');

// payload เดิมที่ firmware ส่งซ้ำทุก 5 วินาที
const steady = { led: false, exhaustFan: false, ac: 0 };

// ---------- 1. ครั้งแรก = sync ไม่ต้อง log ----------
apply('living', steady);
check('ครั้งแรก (sync) -> ไม่ log', logged.length, 0);
check('  แต่ state อัปเดตแล้ว', rooms.living.devices.light.state, false);
check('  ac sync เป็น 0', rooms.living.devices.ac.level, 0);

// ---------- 2. ส่ง payload เดิมซ้ำ 20 ครั้ง (= 100 วินาที) ----------
for (let i = 0; i < 20; i++) apply('living', steady);
check('payload เดิมซ้ำ 20 ครั้ง -> ยังไม่ log', logged.length, 0);

// ---------- 3. ไฟเปิดจริง -> ต้อง log 1 ครั้ง ----------
apply('living', { led: true, exhaustFan: false, ac: 0 });
check('ไฟเปิด -> log 1 ครั้ง', logged, ['living:Light ON']);

// ---------- 4. ส่งซ้ำสถานะไฟเปิด 10 ครั้ง -> ไม่ log เพิ่ม ----------
for (let i = 0; i < 10; i++) apply('living', { led: true, exhaustFan: false, ac: 0 });
check('  ส่งซ้ำ 10 ครั้ง -> ไม่ log เพิ่ม', logged.length, 1);

// ---------- 5. ไฟปิด -> log อีกครั้ง ----------
apply('living', { led: false, exhaustFan: false, ac: 0 });
check('ไฟปิด -> log เพิ่ม', logged, ['living:Light ON', 'living:Light OFF']);

// ---------- 6. หลายอุปกรณ์เปลี่ยนพร้อมกัน ----------
logged.length = 0;
apply('living', { led: true, exhaustFan: true, ac: 90 });
check('3 อย่างเปลี่ยนพร้อมกัน -> log 3 ครั้ง', logged.length, 3);
check('  มี Light ON', logged.includes('living:Light ON'), true);
check('  มี Fan ON', logged.includes('living:Fan ON'), true);
check('  มี AC COOL', logged.includes('living:AC COOL'), true);
check('  ac level แปลงถูก (90->2)', rooms.living.devices.ac.level, 2);

// ---------- 7. AC ปิด -> ข้อความ AC OFF ไม่ใช่ Level 0 ----------
logged.length = 0;
apply('living', { led: true, exhaustFan: true, ac: 0 });
check('AC ปิด -> "AC OFF"', logged, ['living:AC OFF']);
check('  ac.state = false', rooms.living.devices.ac.state, false);

// ---------- 8. bedroom ใช้ field fan (ไม่ใช่ exhaustFan) ----------
logged.length = 0;
apply('bedroom', { led: true, fan: true, ac: 0, window: 0 });   // sync
check('bedroom sync -> ไม่ log', logged.length, 0);
apply('bedroom', { led: true, fan: false, ac: 0, window: 0 });
check('bedroom พัดลมปิด -> log', logged, ['bedroom:Fan OFF']);
check('  เขียนลง devices.fan ถูก', rooms.bedroom.devices.fan.state, false);

// ---------- 9. window (ผ้าม่านถูกถอดออกจาก UI แล้ว) ----------
// backend ยังส่ง curtain มาใน payload อยู่ - frontend ต้องเมินได้ ไม่ throw
logged.length = 0;
apply('kitchen', { led: false, exhaustFan: true, window: 0, curtain: 'stop' });  // sync
check('kitchen sync -> ไม่ log', logged.length, 0);

apply('kitchen', { led: false, exhaustFan: true, window: 180, curtain: 'stop' });
check('หน้าต่างเปิด -> log', logged, ['kitchen:Window OPEN']);
check('  state = open', rooms.kitchen.devices.window.state, 'open');

logged.length = 0;
for (let i = 0; i < 5; i++) apply('kitchen', { led: false, exhaustFan: true, window: 180, curtain: 'stop' });
check('  ส่งซ้ำ -> ไม่ log', logged.length, 0);

apply('kitchen', { led: false, exhaustFan: true, window: 180, curtain: 'open' });
check('curtain เปลี่ยน -> ไม่ log (ถอดออกแล้ว)', logged.length, 0);

// ---------- 10. แต่ละห้องนับ firstSync แยกกัน ----------
check('living/kitchen/bedroom sync แยกกัน',
  [synced().living, synced().kitchen, synced().bedroom],
  [true, true, true]);

// ---------- 11. ห้องไม่รู้จัก -> ไม่ crash ----------
logged.length = 0;
apply('garage', { led: true });
check('ห้องไม่รู้จัก -> ไม่ crash ไม่ log', logged.length, 0);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
