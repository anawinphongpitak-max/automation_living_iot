/*
 * ทดสอบ automatic mode logic ที่ดึงมาจาก smart_home.ino จริง
 *
 * วิธีทำงาน: สคริปต์ extract_logic.js ตัดส่วน logic ออกจาก .ino แล้ว
 * generate ไฟล์ auto_logic.inc ให้ไฟล์นี้ include เข้ามา compile กับ stub
 * ทำให้เทสวิ่งบนโค้ดจริง ไม่ใช่โค้ดที่ลอกมาวางซ้ำ
 *
 * build: g++ -std=c++17 -o test_auto test_auto_mode.cpp && ./test_auto
 */
#include "arduino_stub.h"
#include <iostream>
#include <algorithm>

// ---------- นิยาม global ของ stub ----------
unsigned long g_fakeMillis = 0;
std::map<int, int> g_pinState;
std::map<int, int> g_relayWrites;
std::map<int, int> g_pwmWrites;
std::vector<std::string> g_serialLines;
SerialStub Serial;

// ---------- MQTT publish ปลอม: เก็บ topic ที่ถูกส่ง ----------
std::vector<std::string> g_published;

// ---------- logic จริงจาก smart_home.ino ----------
#include "auto_logic.inc"

// ================= test harness =================
static int pass = 0, fail = 0;

void check(const std::string& label, bool ok, const std::string& detail = "") {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << label;
  if (!ok && !detail.empty()) std::cout << "   (" << detail << ")";
  std::cout << "\n";
  ok ? pass++ : fail++;
}

void checkEq(const std::string& label, int actual, int expected) {
  check(label, actual == expected,
        "got " + std::to_string(actual) + ", expected " + std::to_string(expected));
}

// relay active LOW: LOW(0) = เปิด, HIGH(1) = ปิด
bool relayOn(int pin) { return g_relayWrites.count(pin) && g_relayWrites[pin] == LOW; }
bool relayOff(int pin) { return g_relayWrites.count(pin) && g_relayWrites[pin] == HIGH; }
int  pwmDuty(int ch) { return g_pwmWrites.count(ch) ? g_pwmWrites[ch] : -1; }

void setMotion(int pin, bool on) { g_pinState[pin] = on ? HIGH : LOW; }
void advance(unsigned long ms) { g_fakeMillis += ms; }

/** เดินเวลาแบบเรียก loop ถี่ๆ เหมือนของจริง */
void runFor(unsigned long ms, unsigned long step = 100) {
  for (unsigned long t = 0; t < ms; t += step) {
    advance(step);
    updateAutomaticMode();
  }
}

void resetAll() {
  g_fakeMillis = 1000;
  g_pinState.clear();
  g_relayWrites.clear();
  g_pwmWrites.clear();
  g_serialLines.clear();
  g_published.clear();
  currentMode = MODE_MANUAL;
  for (int i = 0; i < ROOM_COUNT; i++) {
    roomAuto[i] = RoomAuto{};
    roomAuto[i].lastMotion = g_fakeMillis;
  }
  setMotion(PIN_PIR_LIVING, false);
  setMotion(PIN_PIR_KITCHEN, false);
  setMotion(PIN_PIR_BEDROOM, false);
}

bool loggedContains(const std::string& needle) {
  for (auto& l : g_serialLines) if (l.find(needle) != std::string::npos) return true;
  return false;
}

int main() {
  std::cout << "=== PHASE 1: Manual / Automatic mode ===\n\n";

  // ---------------------------------------------------------
  std::cout << "[1] Manual mode: PIR ไม่แตะอุปกรณ์\n";
  resetAll();
  userSetLED(ROOM_LIVING, true);
  userSetFan(ROOM_LIVING, true);
  userSetAC(ROOM_LIVING, 90);
  check("ผู้ใช้เปิดไฟได้", relayOn(PIN_LIVING_LED));
  check("ผู้ใช้เปิดพัดลมได้", relayOn(PIN_LIVING_FAN));
  checkEq("ผู้ใช้ตั้งแอร์ 90 -> duty 230", pwmDuty(PWM_CHANNEL_LIVING), 230);

  runFor(30000);   // ปล่อยเงียบ 30 วินาที (เกิน timeout ทั้งสอง)
  check("manual: ไฟยังเปิดอยู่", relayOn(PIN_LIVING_LED));
  check("manual: พัดลมยังเปิดอยู่", relayOn(PIN_LIVING_FAN));
  checkEq("manual: แอร์ยังเปิดอยู่", pwmDuty(PWM_CHANNEL_LIVING), 230);
  check("manual: ไม่มี log auto shutdown", !loggedContains("[AUTO] Turning OFF"));

  // ---------------------------------------------------------
  std::cout << "\n[2] สลับเข้า automatic: ไม่เปลี่ยนสถานะทันที\n";
  setOperatingMode(true);
  check("โหมดเป็น automatic", currentMode == MODE_AUTOMATIC);
  check("log [MODE] Automatic enabled", loggedContains("[MODE] Automatic enabled"));
  check("ไฟยังเปิด (ไม่เปลี่ยนทันที)", relayOn(PIN_LIVING_LED));
  checkEq("แอร์ยังเปิด (ไม่เปลี่ยนทันที)", pwmDuty(PWM_CHANNEL_LIVING), 230);
  check("publish home/status/mode", std::count(g_published.begin(), g_published.end(),
        std::string("home/status/mode")) > 0);

  // ---------------------------------------------------------
  std::cout << "\n[3] ครบ 5 วินาที -> ปิดไฟ+พัดลม / ครบ 10 -> ปิดแอร์\n";
  runFor(4000);
  check("ที่ 4 วินาที: ไฟยังเปิด", relayOn(PIN_LIVING_LED));

  runFor(1500);   // ~5.5s
  check("ที่ 5 วินาที: ไฟถูกปิด", relayOff(PIN_LIVING_LED));
  check("  พัดลมถูกปิด", relayOff(PIN_LIVING_FAN));
  checkEq("  แอร์ยังเปิด (ยังไม่ถึง 10s)", pwmDuty(PWM_CHANNEL_LIVING), 230);
  check("  log inactive 5 seconds", loggedContains("inactive for 5 seconds"));
  check("  log [AUTO SHUTDOWN] LED/FAN", loggedContains("[AUTO SHUTDOWN] Living Room LED/FAN"));

  runFor(5000);   // ~10.5s
  checkEq("ที่ 10 วินาที: แอร์ถูกปิด", pwmDuty(PWM_CHANNEL_LIVING), 0);
  check("  log inactive 10 seconds", loggedContains("inactive for 10 seconds"));
  check("  log [AUTO SHUTDOWN] AC", loggedContains("[AUTO SHUTDOWN] Living Room AC"));

  // ---------------------------------------------------------
  std::cout << "\n[4] มีคนกลับมา -> คืนค่าตามที่ผู้ใช้ตั้งไว้\n";
  setMotion(PIN_PIR_LIVING, true);
  updateAutomaticMode();
  check("ไฟกลับมาเปิด (user=ON)", relayOn(PIN_LIVING_LED));
  check("พัดลมกลับมาเปิด (user=ON)", relayOn(PIN_LIVING_FAN));
  checkEq("แอร์กลับมาที่ 90 (user=90)", pwmDuty(PWM_CHANNEL_LIVING), 230);
  check("log Motion Detected", loggedContains("Motion Detected"));
  check("log Restoring user device states", loggedContains("Restoring user device states"));

  // ---------------------------------------------------------
  std::cout << "\n[5] ไม่คืนค่าแบบเปิดหมด - ของที่ผู้ใช้ปิดไว้ต้องคงปิด\n";
  resetAll();
  userSetLED(ROOM_LIVING, true);     // LED ON
  userSetFan(ROOM_LIVING, false);    // Fan OFF  <- ผู้ใช้ตั้งปิด
  userSetAC(ROOM_LIVING, 70);        // AC ON
  setOperatingMode(true);

  runFor(11000);
  check("ไฟถูกปิดอัตโนมัติ", relayOff(PIN_LIVING_LED));
  checkEq("แอร์ถูกปิดอัตโนมัติ", pwmDuty(PWM_CHANNEL_LIVING), 0);

  setMotion(PIN_PIR_LIVING, true);
  updateAutomaticMode();
  check("คืนค่า: LED = ON", relayOn(PIN_LIVING_LED));
  check("คืนค่า: Fan = OFF (ไม่เปิดพร่ำเพรื่อ)", relayOff(PIN_LIVING_FAN));
  checkEq("คืนค่า: AC = 70", pwmDuty(PWM_CHANNEL_LIVING), 179);

  // ---------------------------------------------------------
  std::cout << "\n[6] SAFETY: คำสั่งใหม่ของผู้ใช้ชนะค่าที่จำไว้\n";
  resetAll();
  userSetLED(ROOM_LIVING, true);     // เดิม ON
  setOperatingMode(true);
  runFor(6000);
  check("auto ปิดไฟแล้ว", relayOff(PIN_LIVING_LED));

  // ผู้ใช้กด OFF ระหว่างที่ห้องยังเงียบ
  userSetLED(ROOM_LIVING, false);
  check("  ผู้ใช้สั่ง OFF -> ยังปิด", relayOff(PIN_LIVING_LED));

  setMotion(PIN_PIR_LIVING, true);
  updateAutomaticMode();
  check("มีคนกลับมา -> ไฟต้องยังปิด (ตาม user ล่าสุด)", relayOff(PIN_LIVING_LED));

  // ---------------------------------------------------------
  std::cout << "\n[7] ผู้ใช้เปิดเองตอนห้องเงียบ - auto ต้องไม่แย่งปิดซ้ำ\n";
  resetAll();
  setOperatingMode(true);
  runFor(6000);                      // latch ยิงไปแล้ว
  userSetLED(ROOM_LIVING, true);     // ผู้ใช้เปิดเองตอนยังไม่มีคน
  check("ผู้ใช้เปิดไฟได้", relayOn(PIN_LIVING_LED));
  runFor(3000);                      // เวลาเดินต่อ ยังไม่มีคน
  check("auto ไม่ปิดซ้ำทันที", relayOn(PIN_LIVING_LED));

  // ---------------------------------------------------------
  std::cout << "\n[8] แต่ละห้องนับเวลาแยกกัน\n";
  resetAll();
  userSetLED(ROOM_LIVING, true);
  userSetLED(ROOM_KITCHEN, true);
  userSetLED(ROOM_BEDROOM, true);
  setOperatingMode(true);

  // ครัวมีคนอยู่ตลอด อีกสองห้องเงียบ
  setMotion(PIN_PIR_KITCHEN, true);
  runFor(7000);

  check("living เงียบ -> ไฟดับ", relayOff(PIN_LIVING_LED));
  check("bedroom เงียบ -> ไฟดับ", relayOff(PIN_BEDROOM_LED));
  check("kitchen มีคน -> ไฟยังติด", relayOn(PIN_KITCHEN_LED));

  // ---------------------------------------------------------
  std::cout << "\n[9] ครัวไม่มีแอร์ - ต้องไม่ยุ่ง PWM\n";
  resetAll();
  setOperatingMode(true);
  int livingBefore = pwmDuty(PWM_CHANNEL_LIVING);
  int bedroomBefore = pwmDuty(PWM_CHANNEL_BEDROOM);
  userSetAC(ROOM_KITCHEN, 90);       // ครัวไม่มีแอร์
  checkEq("สั่งแอร์ครัว -> living PWM ไม่เปลี่ยน", pwmDuty(PWM_CHANNEL_LIVING), livingBefore);
  checkEq("สั่งแอร์ครัว -> bedroom PWM ไม่เปลี่ยน", pwmDuty(PWM_CHANNEL_BEDROOM), bedroomBefore);

  // ---------------------------------------------------------
  std::cout << "\n[10] กลับไป manual: หยุด auto ไม่คืนค่าย้อนหลัง\n";
  resetAll();
  userSetLED(ROOM_BEDROOM, true);
  setOperatingMode(true);
  runFor(6000);
  check("auto ปิดไฟห้องนอนแล้ว", relayOff(PIN_BEDROOM_LED));

  setOperatingMode(false);
  check("โหมดเป็น manual", currentMode == MODE_MANUAL);
  check("log [AUTO MODE] Disabled", loggedContains("[AUTO MODE] Disabled"));
  check("ไฟยังปิดอยู่ (ไม่คืนค่าทันที)", relayOff(PIN_BEDROOM_LED));

  setMotion(PIN_PIR_BEDROOM, true);
  runFor(3000);
  check("manual: มีคนก็ไม่คืนค่าอัตโนมัติ", relayOff(PIN_BEDROOM_LED));

  // ---------------------------------------------------------
  std::cout << "\n[11] PIR log ไม่ท่วม (จับเฉพาะขอบขา)\n";
  resetAll();
  setOperatingMode(true);
  g_serialLines.clear();
  setMotion(PIN_PIR_BEDROOM, true);
  for (int i = 0; i < 50; i++) { advance(100); updateAutomaticMode(); }
  int motionLogs = 0;
  for (auto& l : g_serialLines)
    if (l.find("Motion Detected") != std::string::npos) motionLogs++;
  checkEq("มีคนอยู่ต่อเนื่อง -> log ครั้งเดียว", motionLogs, 1);

  // ---------------------------------------------------------
  std::cout << "\n[12] ประตู/หน้าต่างไม่อยู่ใน automatic mode\n";
  resetAll();
  setOperatingMode(true);
  g_relayWrites.erase(PIN_DOOR_LOCK);
  runFor(20000);
  check("auto ไม่แตะ relay ประตู", g_relayWrites.count(PIN_DOOR_LOCK) == 0);

  std::cout << "\n=== " << pass << " passed, " << fail << " failed ===\n";
  return fail == 0 ? 0 : 1;
}
