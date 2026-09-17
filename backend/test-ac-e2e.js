/**
 * ทดสอบ seam ระหว่าง frontend -> backend สำหรับ AC โดยไม่ต้องเปิดเบราว์เซอร์
 *
 * โหลด mqtt-client.js ตัวจริงมารันใน Node (ใส่ fetch/WebSocket ปลอมให้)
 * แล้วเรียก controlAC ด้วยค่าเดียวกับที่ปุ่มบนหน้าเว็บส่ง
 * จากนั้นดัก MQTT ดูว่า backend publish ออกถูก topic/payload
 *
 * ต้องรัน backend ไว้ก่อน (npm start)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mqtt = require('mqtt');

const CLIENT_PATH = path.join(__dirname, '../frontend/mqtt-client.js');

// ---------- โหลด mqtt-client.js ตัวจริงเข้า sandbox ----------
const sandbox = {
  console,
  fetch: globalThis.fetch,
  setTimeout,
  clearTimeout,
  WebSocket: class { constructor() {} close() {} },  // ไม่ใช้ในเทสนี้
  requestedUrls: []
};

// ห่อ fetch เพื่อบันทึก URL ที่ถูกเรียก
sandbox.fetch = async (url, opts) => {
  sandbox.requestedUrls.push({ url, method: opts?.method || 'GET' });
  return globalThis.fetch(url, opts);
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox);
vm.runInContext('globalThis.__client = mqttClient;', sandbox);
const client = sandbox.__client;

// ---------- ค่าที่ปุ่มบนหน้าเว็บส่งจริง ----------
// data-ac-room -> roomId, data-level -> level (script.js:1713-1715)
const CASES = [
  { room: 'living',  level: 1, expectTopic: 'home/control/living/ac',  expectLevel: 70  },
  { room: 'living',  level: 2, expectTopic: 'home/control/living/ac',  expectLevel: 90  },
  { room: 'living',  level: 3, expectTopic: 'home/control/living/ac',  expectLevel: 100 },
  { room: 'bedroom', level: 1, expectTopic: 'home/control/bedroom/ac', expectLevel: 70  },
  { room: 'bedroom', level: 0, expectTopic: 'home/control/bedroom/ac', expectLevel: 0   }  // สวิตช์ปิด
];

const captured = [];
let passed = 0;
let failed = 0;

const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  ok ? passed++ : failed++;
};

const sniffer = mqtt.connect(process.env.MQTT_BROKER, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD
});

sniffer.on('message', (topic, payload) => {
  captured.push({ topic, payload: JSON.parse(payload.toString()) });
});

sniffer.on('connect', () => {
  sniffer.subscribe('home/control/+/ac', async err => {
    if (err) { console.error('subscribe failed:', err.message); process.exit(1); }

    console.log('=== AC end-to-end: mqtt-client.js -> backend -> MQTT ===\n');

    for (const c of CASES) {
      captured.length = 0;
      sandbox.requestedUrls.length = 0;

      const result = await client.controlAC(c.room, c.level);
      await new Promise(r => setTimeout(r, 700));   // รอ MQTT วิ่งกลับมา

      console.log(`${c.room} level ${c.level}`);
      check('HTTP URL', sandbox.requestedUrls[0]?.url,
        `http://localhost:3000/api/ac/${c.room}/${c.level}`);
      check('method', sandbox.requestedUrls[0]?.method, 'POST');
      check('backend success', result?.success, true);
      check('MQTT topic', captured[0]?.topic, c.expectTopic);
      check('MQTT level', captured[0]?.payload?.level, c.expectLevel);
      console.log('');
    }

    console.log(`=== ${passed} passed, ${failed} failed ===`);
    sniffer.end();
    process.exit(failed === 0 ? 0 : 1);
  });
});

sniffer.on('error', e => { console.error('mqtt error:', e.message); process.exit(1); });
