/**
 * ดักดู MQTT ที่ backend publish ออกจริง ตอนยิง /api/ac/:room/:level
 * ใช้ยืนยันว่าฝั่ง backend ทำงานถูก (แยกจากปัญหาปุ่มบนหน้าเว็บ)
 */
require('dotenv').config();
const mqtt = require('mqtt');
const http = require('http');

const client = mqtt.connect(process.env.MQTT_BROKER, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD
});

let captured = 0;

client.on('connect', () => {
  client.subscribe('home/control/+/ac', err => {
    if (err) { console.error('subscribe failed:', err.message); process.exit(1); }
    console.log('subscribed to home/control/+/ac\n');

    // ยิงหลัง subscribe ยืนยันแล้วเท่านั้น ไม่งั้น publish แรกจะหลุด
    [1, 2, 3].forEach((level, i) => {
      setTimeout(() => {
        console.log(`POST /api/ac/bedroom/${level}`);
        http.request(
          { host: 'localhost', port: 3000, path: `/api/ac/bedroom/${level}`, method: 'POST' },
          res => res.resume()
        ).end();
      }, 400 * i);
    });

    setTimeout(() => {
      console.log(`\ntotal captured: ${captured} / 3`);
      process.exit(captured === 3 ? 0 : 1);
    }, 4000);
  });
});

client.on('message', (topic, payload) => {
  captured++;
  console.log(`  -> captured: ${topic} ${payload.toString()}`);
});

client.on('error', e => { console.error('error:', e.message); process.exit(1); });
