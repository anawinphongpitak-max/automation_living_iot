/**
 * ทดสอบ door แบบ end-to-end: mqtt-client.js ตัวจริง -> backend -> MQTT -> WS กลับ
 *
 * ต้องรัน backend + mock-esp32 ไว้ก่อน
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');

const CLIENT_PATH = path.join(__dirname, '../frontend/mqtt-client.js');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

// ---------- โหลด mqtt-client.js ตัวจริง ----------
const urls = [];
const sandbox = {
  console: { log() {}, error() {} },
  setTimeout, clearTimeout,
  WebSocket: class { constructor() {} close() {} },
  fetch: async (url, opts) => {
    urls.push({ url, method: opts?.method || 'GET' });
    return globalThis.fetch(url, opts);
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox);
vm.runInContext('globalThis.__c = mqttClient;', sandbox);
const client = sandbox.__c;

// ---------- ดัก WS ดูสถานะที่ backend ส่งกลับ ----------
const doorMessages = [];
let initialDoor = null;

const ws = new WebSocket('ws://localhost:3000');

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'initial_state' && initialDoor === null) {
    initialDoor = m.state.door;
  }
  if (m.type === 'mqtt_message' && m.topic === 'home/status/door') {
    doorMessages.push(m.payload);
  }
});

ws.on('open', async () => {
  console.log('=== door end-to-end ===\n');
  await new Promise(r => setTimeout(r, 1200));

  check('initial_state มี door', typeof initialDoor === 'string', true);

  // ---------- unlock ----------
  doorMessages.length = 0;
  const r1 = await client.controlDoor('unlock');
  await new Promise(r => setTimeout(r, 1500));

  check('URL ถูก (unlock)', urls.at(-1).url, 'http://localhost:3000/api/door/unlock');
  check('  method POST', urls.at(-1).method, 'POST');
  check('  backend success', r1?.success, true);
  check('  WS ส่ง locked:false กลับ', doorMessages.some(p => p.locked === false), true);

  // ---------- lock ----------
  doorMessages.length = 0;
  const r2 = await client.controlDoor('lock');
  await new Promise(r => setTimeout(r, 1500));

  check('URL ถูก (lock)', urls.at(-1).url, 'http://localhost:3000/api/door/lock');
  check('  backend success', r2?.success, true);
  check('  WS ส่ง locked:true กลับ', doorMessages.some(p => p.locked === true), true);

  // ---------- คำสั่งผิด ----------
  const r3 = await client.controlDoor('explode');
  check('คำสั่งผิด -> success false', r3?.success, false);
  check('  มี error message', typeof r3?.error === 'string', true);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
});

ws.on('error', e => { console.error('WS error:', e.message); process.exit(1); });

setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);
