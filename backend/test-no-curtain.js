/**
 * ตรวจว่าเอาผ้าม่านออกครบ และไม่ทำให้อะไรพัง
 *
 * จุดเสี่ยงคือ backend ยังส่ง curtain มาใน payload อยู่ (projectState และ
 * home/status/{room}) frontend ต้องเมินเฉยได้โดยไม่ throw
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '../frontend');
const js = fs.readFileSync(path.join(DIR, 'script.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

function slice(start, end) {
  const s = js.indexOf(start);
  if (s === -1) throw new Error(`ไม่พบ: ${start}`);
  const e = js.indexOf(end, s);
  if (e === -1) throw new Error(`ไม่พบ end: ${end}`);
  return js.slice(s, e);
}

console.log('=== ถอดผ้าม่านออกจาก UI ===\n');

// ---------- 1. ไม่เหลือ curtain ในโค้ดเลย ----------
check('ไม่มีคำว่า curtain/Curtain เหลือ', /curtain/i.test(js), false);

// ---------- 2. rooms object ----------
const roomsBlock = slice('const rooms = {', 'const scenes = [');
const sb = {};
vm.createContext(sb);
vm.runInContext(roomsBlock + '\nglobalThis.__r = rooms;', sb);
const rooms = sb.__r;

check('kitchen ไม่มี curtain', 'curtain' in rooms.kitchen.devices, false);
check('bedroom ไม่มี curtain', 'curtain' in rooms.bedroom.devices, false);
check('kitchen ยังมี window', 'window' in rooms.kitchen.devices, true);
check('bedroom ยังมี window', 'window' in rooms.bedroom.devices, true);
check('kitchen เหลือ 3 อุปกรณ์', Object.keys(rooms.kitchen.devices).sort(), ['exhaust', 'light', 'window']);
check('bedroom เหลือ 4 อุปกรณ์', Object.keys(rooms.bedroom.devices).sort(), ['ac', 'fan', 'light', 'window']);
check('living ไม่ถูกแตะ', Object.keys(rooms.living.devices).sort(), ['ac', 'exhaust', 'light']);

// ---------- 3. applyRoomStatus: curtain ใน payload ต้องไม่ทำให้พัง ----------
const logged = [];
const sandbox = {
  console: { log() {} },
  addLog: (room, text) => logged.push(`${room}:${text}`),
  deviceIcon: () => '<span>i</span>',
  rooms: JSON.parse(JSON.stringify(rooms))
};
vm.createContext(sandbox);
vm.runInContext(slice('// ชื่อที่แสดงบนปุ่มแอร์', '/* =====================================================\n   DEVICE STATUS'), sandbox);
vm.runInContext(slice('// ห้องที่เคยได้รับ home/status/{room}', 'let systemStatus'), sandbox);
vm.runInContext(slice('/**\n * อัปเดตสถานะอุปกรณ์ในห้องจาก payload', 'function addLog('), sandbox);
vm.runInContext('globalThis.__apply = applyRoomStatus;', sandbox);
const apply = sandbox.__apply;

// backend/mock ยังส่ง curtain มาด้วย - ต้องเมินได้
let threw = null;
try {
  apply('kitchen', { led: false, exhaustFan: true, window: 0, curtain: 'stop' });   // sync
  apply('kitchen', { led: true, exhaustFan: true, window: 180, curtain: 'open' });
} catch (e) { threw = e.message; }

check('payload มี curtain -> ไม่ throw', threw, null);
check('  window ยังอัปเดตได้', sandbox.rooms.kitchen.devices.window.state, 'open');
check('  ไฟยังอัปเดตได้', sandbox.rooms.kitchen.devices.light.state, true);
check('  ไม่มี log เรื่องผ้าม่าน', logged.some(l => /curtain/i.test(l)), false);
check('  มี log window + light', logged.sort(), ['kitchen:Light ON', 'kitchen:Window OPEN']);

// ---------- 4. updateDeviceStatesFromMQTT: state.servo.curtain ต้องเมินได้ ----------
const usSandbox = {
  console: { log() {} },
  rooms: JSON.parse(JSON.stringify(rooms)),
  activeScene: 'home',
  doorState: { locked: true, unlockTimer: null, unlockSecondsLeft: 0 },
  autoMode: false,
  refreshDoorCard() {},
  renderModeToggle() {}
};
vm.createContext(usSandbox);
vm.runInContext(slice('function updateDeviceStatesFromMQTT(state)', '// Update system status display'), usSandbox);
vm.runInContext('globalThis.__u = updateDeviceStatesFromMQTT;', usSandbox);

threw = null;
try {
  usSandbox.__u({
    led: { living: true, kitchen: false, bedroom: true },
    fan: { living: false, kitchen: true, bedroom: true },
    ac: { living: { level: 2 }, bedroom: { level: 1 } },
    servo: { window: 'open', curtain: 'open' },   // backend ยังส่ง curtain
    scene: 'home',
    door: 'locked'
  });
} catch (e) { threw = e.message; }

check('initial_state มี servo.curtain -> ไม่ throw', threw, null);
check('  window ถูก set จาก servo.window', usSandbox.rooms.kitchen.devices.window.state, 'open');

// ---------- 5. scene "home" ไม่อ้าง curtain แล้ว ----------
const homeScene = slice('if (sceneId === "home") {', 'if (sceneId === "exit")');
check('scene home ไม่แตะ curtain', /curtain/i.test(homeScene), false);
check('  ยังตั้งไฟ kitchen', homeScene.includes('rooms.kitchen.devices.light.state'), true);

// ---------- 6. modal สร้าง scene ไม่โฆษณาผ้าม่าน ----------
check('modal ไม่มี "Kitchen Curtain"', /Kitchen Curtain/.test(js), false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
