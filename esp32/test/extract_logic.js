/**
 * ตัด logic ของ automatic mode ออกจาก smart_home.ino จริง
 * แล้ว generate auto_logic.inc ให้ test_auto_mode.cpp compile
 *
 * ทำแบบนี้เพื่อให้เทสวิ่งบนโค้ดจริง ไม่ใช่โค้ดที่ลอกมาวางซ้ำ
 * (ถ้า .ino เปลี่ยน เทสจะเห็นการเปลี่ยนนั้นทันที)
 *
 * usage: node extract_logic.js
 */
const fs = require('fs');
const path = require('path');

const INO = path.join(__dirname, '../smart_home/smart_home.ino');
const OUT = path.join(__dirname, 'auto_logic.inc');

const src = fs.readFileSync(INO, 'utf8').replace(/\r\n/g, '\n');

/** ตัดช่วงระหว่าง marker สองตัว (รวม start ไม่รวม end) */
function slice(start, end, label) {
  const s = src.indexOf(start);
  if (s === -1) throw new Error(`ไม่พบ marker: ${label} -> ${start.slice(0, 40)}`);
  const e = src.indexOf(end, s + start.length);
  if (e === -1) throw new Error(`ไม่พบ end marker ของ ${label}`);
  return src.slice(s, e);
}

/** ดึงบรรทัด #define ที่ต้องใช้ */
function defines() {
  const wanted = [
    'PIN_DOOR_LOCK', 'PIN_LIVING_LED', 'PIN_LIVING_FAN',
    'PIN_KITCHEN_LED', 'PIN_KITCHEN_FAN', 'PIN_BEDROOM_LED', 'PIN_BEDROOM_FAN',
    'PIN_LIVING_AC', 'PIN_BEDROOM_AC',
    'PIN_PIR_LIVING', 'PIN_PIR_BEDROOM', 'PIN_PIR_KITCHEN',
    'PWM_CHANNEL_LIVING', 'PWM_CHANNEL_BEDROOM'
  ];
  const out = [];
  for (const name of wanted) {
    const m = new RegExp(`^#define\\s+${name}\\s+(\\S+)`, 'm').exec(src);
    if (!m) throw new Error(`ไม่พบ #define ${name}`);
    out.push(`#define ${name} ${m[1]}`);
  }
  return out.join('\n');
}

const parts = [];

parts.push('// ===== GENERATED โดย extract_logic.js - ห้ามแก้มือ =====');
parts.push('// ตัดมาจาก smart_home.ino เพื่อทดสอบ logic บน PC');
parts.push('');
parts.push(defines());
parts.push('');

// state variables ของอุปกรณ์
parts.push(slice('bool doorLocked = true;', 'unsigned long lastSensor', 'device state'));

// mode / timers / RoomAuto struct + forward declarations
parts.push(slice('enum OperatingMode {', '// ===== Helper Functions =====', 'mode block'));

// setRelay / setAC / room helpers
parts.push(slice('void setRelay(int pin, bool on)', '/* =====================================================\n   AUTOMATIC MODE ENGINE', 'helpers'));

// automatic mode engine
parts.push(slice('/* =====================================================\n   AUTOMATIC MODE ENGINE', '/* =====================================================\n   USER COMMANDS', 'engine'));

// user command functions
parts.push(slice('void userSetLED(RoomIndex room, bool on)', '// ===== MQTT Callback =====', 'user commands'));

// publish functions แทนด้วย stub ที่บันทึก topic
parts.push(`
// ---------- publish stubs (แทน MQTT จริง) ----------
extern std::vector<std::string> g_published;
void publishStatusDoor()    { g_published.push_back("home/status/door"); }
void publishStatusLiving()  { g_published.push_back("home/status/living"); }
void publishStatusKitchen() { g_published.push_back("home/status/kitchen"); }
void publishStatusBedroom() { g_published.push_back("home/status/bedroom"); }
void publishStatusMode()    { g_published.push_back("home/status/mode"); }
`);

fs.writeFileSync(OUT, parts.join('\n'), 'utf8');

const lines = parts.join('\n').split('\n').length;
console.log(`generated auto_logic.inc (${lines} บรรทัด) จาก smart_home.ino`);
