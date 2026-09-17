/**
 * ทดสอบ mode toggle แบบ end-to-end: mqtt-client.js ตัวจริง -> backend
 * -> state.system.autoMode -> initial_state ที่ client ใหม่จะได้รับ
 *
 * ต้องรัน backend ไว้ก่อน
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

/** เปิด WS ใหม่เพื่อดูว่า initial_state ที่ client ใหม่ได้รับเป็นอะไร */
function readInitialState() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3000');
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 6000);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'initial_state') {
        clearTimeout(t);
        ws.close();
        resolve(m.state);
      }
    });
    ws.on('error', reject);
  });
}

(async () => {
  console.log('=== mode toggle end-to-end ===\n');

  // ---------- เปิด automation ----------
  const r1 = await client.setAutoMode('on');
  check('URL ถูก (on)', urls.at(-1).url, 'http://localhost:3000/api/auto/on');
  check('  method POST', urls.at(-1).method, 'POST');
  check('  backend success', r1?.success, true);

  let state = await readInitialState();
  check('  state.system.autoMode = true', state.system.autoMode, true);

  // ---------- ปิด ----------
  const r2 = await client.setAutoMode('off');
  check('URL ถูก (off)', urls.at(-1).url, 'http://localhost:3000/api/auto/off');
  check('  backend success', r2?.success, true);

  state = await readInitialState();
  check('  state.system.autoMode = false', state.system.autoMode, false);

  // ---------- คำสั่งผิด ----------
  const r3 = await client.setAutoMode('maybe');
  check('คำสั่งผิด -> success false', r3?.success, false);
  check('  มี error message', typeof r3?.error === 'string', true);

  state = await readInitialState();
  check('  โหมดไม่เปลี่ยนหลังคำสั่งผิด', state.system.autoMode, false);

  // ---------- enable/disable ก็ต้องรับได้ ----------
  const r4 = await client.setAutoMode('enable');
  check('รับ "enable" ได้', r4?.success, true);
  state = await readInitialState();
  check('  autoMode = true', state.system.autoMode, true);

  // คืนค่าเดิม
  await client.setAutoMode('off');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('error:', e.message); process.exit(1); });
