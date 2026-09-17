/**
 * Mock ESP32 - publish sensor/status เข้า broker เหมือน firmware จริง
 * ใช้ทดสอบ dashboard ตอนไม่มีบอร์ดต่ออยู่
 *
 *   node mock-esp32.js          publish ต่อเนื่องทุก 2 วินาที (Ctrl+C เพื่อหยุด)
 *   node mock-esp32.js --once   publish ชุดเดียวแล้วออก
 */
require('dotenv').config();
const mqtt = require('mqtt');

const once = process.argv.includes('--once');

const client = mqtt.connect(process.env.MQTT_BROKER, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  rejectUnauthorized: true
});

// state ของบอร์ดจำลอง - เปลี่ยนตาม command ที่ backend ส่งมา
const board = {
  door: { locked: true },
  living:  { led: false, exhaustFan: false, ac: 0 },
  kitchen: { led: false, exhaustFan: false, window: 0, curtain: 'stop' },
  bedroom: { led: false, fan: false, ac: 0, window: 0, curtain: 'stop' },
  autoMode: false
};

const send = (topic, payload, retain = true) =>
  client.publish(topic, JSON.stringify(payload), { retain });

function publishStatus() {
  send('home/status/door', board.door);
  send('home/status/living', board.living);
  send('home/status/kitchen', board.kitchen);
  send('home/status/bedroom', board.bedroom);
  send('home/status/mode', { mode: board.autoMode ? 'on' : 'off' });
}

function publishSensors() {
  // แกว่งค่ารอบ 28°C / 61% ให้เห็นกราฟขยับ
  send('home/sensor/dht22', {
    temp: +(27.5 + Math.random() * 2).toFixed(1),
    hum:  +(58 + Math.random() * 6).toFixed(1)
  });

  ['living', 'kitchen', 'bedroom'].forEach(room => {
    send(`home/sensor/pir/${room}`, { pir: Math.random() < 0.1 ? 1 : 0 }, false);
  });
}

client.on('connect', () => {
  console.log('[MOCK] Connected to broker');

  // รับคำสั่งเหมือน firmware แล้วอัปเดต state + publish status กลับ
  const controlTopics = [
    'home/control/door',
    'home/control/living/led',  'home/control/living/fan',  'home/control/living/ac',
    'home/control/kitchen/led', 'home/control/kitchen/fan', 'home/control/kitchen/window',
    'home/control/kitchen/curtain',
    'home/control/bedroom/led', 'home/control/bedroom/fan', 'home/control/bedroom/ac',
    'home/control/bedroom/window', 'home/control/bedroom/curtain',
    'home/control/auto'
  ];
  controlTopics.forEach(t => client.subscribe(t));

  publishSensors();
  publishStatus();
  console.log('[MOCK] Published sensors + status');

  if (once) {
    setTimeout(() => { client.end(); process.exit(0); }, 500);
    return;
  }

  setInterval(publishSensors, 2000);
  setInterval(publishStatus, 5000);
  console.log('[MOCK] Publishing every 2s (sensors) / 5s (status). Ctrl+C to stop.');
});

client.on('message', (topic, raw) => {
  let data; try { data = JSON.parse(raw.toString()); } catch { return; }
  console.log('[MOCK] <-', topic, JSON.stringify(data));

  const parts = topic.split('/');   // home/control/{room}/{device}

  if (topic === 'home/control/door') {
    board.door.locked = !!data.locked;
    send('home/status/door', board.door);
    return;
  }

  if (topic === 'home/control/auto') {
    board.autoMode = data.mode === 'on';
    send('home/status/mode', { mode: board.autoMode ? 'on' : 'off' });
    return;
  }

  const room = parts[2];
  const device = parts[3];
  if (!board[room]) return;

  if (device === 'led')    board[room].led = !!data.state;
  if (device === 'fan')    board[room][room === 'bedroom' ? 'fan' : 'exhaustFan'] = !!data.state;
  if (device === 'ac')     board[room].ac = data.level;
  if (device === 'window') board[room].window = data.angle;
  if (device === 'curtain') board[room].curtain = data.action;

  send(`home/status/${room}`, board[room]);
});

client.on('error', e => { console.error('[MOCK] Error:', e.message); process.exit(1); });
