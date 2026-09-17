/**
 * วินิจฉัยว่าทำไม Automatic Mode ไม่ทำงานบนบอร์ดจริง
 *
 * ฟัง broker แล้วตอบ 3 คำถามที่แยกสาเหตุได้:
 *   1. บอร์ดรัน firmware Phase 1 แล้วหรือยัง? (ดูว่ามี home/status/mode ไหม)
 *   2. บอร์ดเข้าโหมด AUTO จริงไหม?
 *   3. PIR อ่านค่าได้ LOW จริงไหม หรือค้าง HIGH?
 *
 * usage: node diagnose-auto.js
 */
require('dotenv').config();
const mqtt = require('mqtt');

const WATCH_SECONDS = 15;

const seen = {
  mode: [],
  pir: { living: [], kitchen: [], bedroom: [] },
  status: { living: [], kitchen: [], bedroom: [] }
};

const client = mqtt.connect(process.env.MQTT_BROKER, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD
});

client.on('connect', () => {
  client.subscribe([
    'home/status/mode',
    'home/sensor/pir/living', 'home/sensor/pir/kitchen', 'home/sensor/pir/bedroom',
    'home/status/living', 'home/status/kitchen', 'home/status/bedroom'
  ], err => {
    if (err) { console.error('subscribe failed:', err.message); process.exit(1); }
    console.log(`ฟัง broker ${WATCH_SECONDS} วินาที...\n`);
  });
});

client.on('message', (topic, raw) => {
  let p; try { p = JSON.parse(raw.toString()); } catch { return; }

  if (topic === 'home/status/mode') seen.mode.push(p.mode);

  const pirMatch = /^home\/sensor\/pir\/(\w+)$/.exec(topic);
  if (pirMatch && seen.pir[pirMatch[1]]) seen.pir[pirMatch[1]].push(p.pir);

  const stMatch = /^home\/status\/(living|kitchen|bedroom)$/.exec(topic);
  if (stMatch) seen.status[stMatch[1]].push(p);
});

client.on('error', e => { console.error('mqtt error:', e.message); process.exit(1); });

setTimeout(() => {
  const line = '='.repeat(62);
  console.log(line);
  console.log(' ผลวินิจฉัย');
  console.log(line);

  // ---------- 1. firmware Phase 1 ----------
  console.log('\n[1] บอร์ดรัน firmware Phase 1 แล้วหรือยัง?');
  if (seen.mode.length === 0) {
    console.log('    x ไม่พบ home/status/mode เลย');
    console.log('    => บอร์ดยังรัน firmware ตัวเก่า ไม่มี Automatic Mode อยู่ในนั้น');
    console.log('    => ต้องอัปโหลด smart_home.ino ตัวใหม่เข้าบอร์ดก่อน   <<< น่าจะเป็นสาเหตุ');
  } else {
    console.log(`    v พบ ${seen.mode.length} ครั้ง - บอร์ดรัน Phase 1 แล้ว`);
  }

  // ---------- 2. โหมดที่บอร์ดอยู่ ----------
  console.log('\n[2] บอร์ดอยู่โหมดไหน?');
  if (seen.mode.length === 0) {
    console.log('    ไม่ทราบ (บอร์ดไม่ได้รายงานโหมด)');
  } else {
    const last = seen.mode[seen.mode.length - 1];
    console.log(`    ล่าสุด: ${last === 'on' ? 'AUTOMATIC' : 'MANUAL'}`);
    if (last !== 'on') {
      console.log('    => บอร์ดยังเป็น MANUAL จึงไม่ปิดอุปกรณ์ (ถูกต้องตามสเปก)');
      console.log('    => ตรวจว่ากดปุ่มบน dashboard แล้วคำสั่งถึงบอร์ดจริงไหม');
    }
  }

  // ---------- 3. PIR ----------
  console.log('\n[3] PIR อ่านค่าได้อย่างไร? (0 = ไม่มีคน, 1 = มีคน)');
  const stuckHigh = [];
  for (const room of ['living', 'kitchen', 'bedroom']) {
    const vals = seen.pir[room];
    if (vals.length === 0) {
      console.log(`    ${room.padEnd(8)}: ไม่มีข้อมูล`);
      continue;
    }
    const ones = vals.filter(v => v === 1).length;
    const pct = Math.round((ones / vals.length) * 100);
    console.log(`    ${room.padEnd(8)}: ${vals.join(',')}   (HIGH ${pct}% จาก ${vals.length} ครั้ง)`);
    if (pct === 100) stuckHigh.push(room);
  }

  if (stuckHigh.length) {
    console.log(`\n    x PIR ค้าง HIGH ตลอด: ${stuckHigh.join(', ')}`);
    console.log('    => ตัวนับ inactivity ถูกรีเซ็ตทุก loop จึงไม่ครบ timeout');
    console.log('    => สาเหตุที่พบบ่อย:');
    console.log('       - HC-SR501 jumper อยู่ที่ H (repeat trigger) + pot Time Delay ตั้งไว้สูง');
    console.log('         ลองหมุน pot "Time Delay" ทวนเข็มจนสุด (ต่ำสุด ~3 วินาที)');
    console.log('       - GPIO 34/35/36 เป็น input-only ไม่มี pull resistor ในตัว');
    console.log('         ถ้าสาย OUT หลุดหรือไม่ได้ต่อ ขาจะลอยและอ่านเป็น HIGH ได้');
    console.log('       - PIR ยังอุ่นเครื่องไม่เสร็จ (ต้องรอ ~30-60 วินาทีหลังจ่ายไฟ)');
  } else if (seen.pir.living.length) {
    console.log('\n    v PIR อ่านค่าเปลี่ยนได้ปกติ');
  }

  // ---------- 4. สถานะอุปกรณ์ ----------
  console.log('\n[4] สถานะอุปกรณ์ล่าสุดที่บอร์ดรายงาน');
  for (const room of ['living', 'kitchen', 'bedroom']) {
    const arr = seen.status[room];
    if (arr.length === 0) { console.log(`    ${room.padEnd(8)}: ไม่มีข้อมูล`); continue; }
    console.log(`    ${room.padEnd(8)}: ${JSON.stringify(arr[arr.length - 1])}`);
  }

  console.log('\n' + line);
  client.end();
  process.exit(0);
}, WATCH_SECONDS * 1000);
