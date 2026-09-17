/**
 * PHASE 1 e2e: โหมด sync ครบสาย Dashboard -> Backend -> MQTT -> บอร์ด -> กลับ
 *
 * ตรวจว่า:
 *   - กดปุ่มบน dashboard -> บอร์ดรับรู้ -> ตอบ home/status/mode กลับ
 *   - backend ยึดโหมดจากบอร์ดเป็นหลัก (source of truth)
 *   - client ที่ต่อเข้ามาใหม่ได้โหมดล่าสุดทาง initial_state
 *   - บอร์ดสั่งเปลี่ยนโหมดเอง -> backend/dashboard ตามทัน
 *
 * ต้องรัน backend + mock-esp32 ไว้ก่อน
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');
const mqtt = require('mqtt');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

// ---------- โหลด mqtt-client.js ตัวจริง (ฝั่ง dashboard) ----------
const urls = [];
const cs = {
  console: { log() {}, error() {} },
  setTimeout, clearTimeout,
  WebSocket: class { constructor() {} close() {} },
  fetch: async (url, opts) => { urls.push(url); return globalThis.fetch(url, opts); }
};
vm.createContext(cs);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/mqtt-client.js'), 'utf8'), cs);
vm.runInContext('globalThis.__c = mqttClient;', cs);
const client = cs.__c;

/** เปิด WS ใหม่ อ่าน initial_state (จำลอง dashboard เปิดหน้าใหม่) */
function readInitialState() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3000');
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 6000);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'initial_state') { clearTimeout(t); ws.close(); resolve(m.state); }
    });
    ws.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== PHASE 1 e2e: mode sync ===\n');

  // ---------- ดัก MQTT ดูว่าบอร์ดตอบ status/mode ----------
  const modeMsgs = [];
  const sniffer = mqtt.connect(process.env.MQTT_BROKER, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
  });
  await new Promise((res, rej) => {
    sniffer.on('connect', () => sniffer.subscribe(['home/status/mode', 'home/control/auto'], e => e ? rej(e) : res()));
    sniffer.on('error', rej);
  });
  sniffer.on('message', (t, p) => modeMsgs.push({ topic: t, payload: JSON.parse(p.toString()) }));

  // ---------- 1. กด Automation จาก dashboard ----------
  modeMsgs.length = 0;
  const r1 = await client.setAutoMode('on');
  await sleep(1800);

  check('URL ที่ยิง', urls.at(-1), 'http://localhost:3000/api/auto/on');
  check('  backend success', r1?.success, true);
  check('  backend publish home/control/auto',
    modeMsgs.some(m => m.topic === 'home/control/auto' && m.payload.mode === 'on'), true);
  check('  บอร์ดตอบ home/status/mode = on',
    modeMsgs.some(m => m.topic === 'home/status/mode' && m.payload.mode === 'on'), true);

  let state = await readInitialState();
  check('  initial_state.system.autoMode = true', state.system.autoMode, true);

  // ---------- 2. กด Manual ----------
  modeMsgs.length = 0;
  const r2 = await client.setAutoMode('off');
  await sleep(1800);

  check('URL ที่ยิง (off)', urls.at(-1), 'http://localhost:3000/api/auto/off');
  check('  บอร์ดตอบ home/status/mode = off',
    modeMsgs.some(m => m.topic === 'home/status/mode' && m.payload.mode === 'off'), true);

  state = await readInitialState();
  check('  initial_state.system.autoMode = false', state.system.autoMode, false);

  // ---------- 3. บอร์ดเป็น source of truth ----------
  // ยิง home/control/auto เข้า MQTT ตรงๆ ไม่ผ่าน REST API ของ backend
  // backend ไม่เคยเห็นคำสั่งนี้ ถ้า state ตามได้ = มาจาก status/mode ของบอร์ดจริง
  const pub = mqtt.connect(process.env.MQTT_BROKER, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
  });
  await new Promise(res => pub.on('connect', res));

  urls.length = 0;
  pub.publish('home/control/auto', JSON.stringify({ mode: 'on' }));
  await sleep(2000);

  check('ไม่ได้เรียก REST API เลย', urls.length, 0);
  state = await readInitialState();
  check('บอร์ดสลับเอง -> backend ตามจาก status/mode', state.system.autoMode, true);

  // คืนค่าเดิม (ผ่านบอร์ดเหมือนกัน)
  pub.publish('home/control/auto', JSON.stringify({ mode: 'off' }));
  await sleep(2000);
  state = await readInitialState();
  check('  คืนเป็น off ได้', state.system.autoMode, false);

  // ---------- 4. คำสั่งผิดไม่เปลี่ยนอะไร ----------
  const r3 = await client.setAutoMode('perhaps');
  check('คำสั่งผิด -> success false', r3?.success, false);
  await sleep(1200);
  state = await readInitialState();
  check('  โหมดไม่เปลี่ยน', state.system.autoMode, false);

  sniffer.end();
  pub.end();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('error:', e.message); process.exit(1); });
