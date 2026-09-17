/*
 * รีโปรสถานการณ์ที่รายงานเข้ามาเป๊ะๆ บน logic จริงจาก smart_home.ino
 *
 *   1. เปิดอุปกรณ์ทุกตัวด้วยมือ
 *   2. สลับ MANUAL -> AUTOMATIC
 *   3. PIR ไม่เจอคนเลยตลอด
 *   4. รอเกิน timeout
 *   -> อุปกรณ์ต้องดับ
 *
 * แยกให้ชัดว่าเป็นบั๊ก logic หรือเป็นเรื่อง PIR อ่านค่าค้าง HIGH
 *
 * build: g++ -std=c++17 -o repro.exe repro_report.cpp && ./repro.exe
 */
#include "arduino_stub.h"
#include <iostream>
#include <algorithm>

unsigned long g_fakeMillis = 0;
std::map<int, int> g_pinState;
std::map<int, int> g_relayWrites;
std::map<int, int> g_pwmWrites;
std::vector<std::string> g_serialLines;
SerialStub Serial;
std::vector<std::string> g_published;

#include "auto_logic.inc"

static int pass = 0, fail = 0;
void check(const std::string& label, bool ok) {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << label << "\n";
  ok ? pass++ : fail++;
}

bool relayOn(int pin)  { return g_relayWrites.count(pin) && g_relayWrites[pin] == LOW; }
bool relayOff(int pin) { return g_relayWrites.count(pin) && g_relayWrites[pin] == HIGH; }
int  pwmDuty(int ch)   { return g_pwmWrites.count(ch) ? g_pwmWrites[ch] : -1; }

void resetAll() {
  g_fakeMillis = 1000;
  g_pinState.clear(); g_relayWrites.clear(); g_pwmWrites.clear();
  g_serialLines.clear(); g_published.clear();
  currentMode = MODE_MANUAL;
  for (int i = 0; i < ROOM_COUNT; i++) {
    roomAuto[i] = RoomAuto{};
    roomAuto[i].lastMotion = g_fakeMillis;
  }
}

/** เดินเวลาแบบเรียก loop ถี่ๆ เหมือน loop() ของจริง */
void runFor(unsigned long ms) {
  for (unsigned long t = 0; t < ms; t += 50) {
    g_fakeMillis += 50;
    updateAutomaticMode();
  }
}

void turnEverythingOn() {
  userSetLED(ROOM_LIVING, true);   userSetFan(ROOM_LIVING, true);   userSetAC(ROOM_LIVING, 100);
  userSetLED(ROOM_KITCHEN, true);  userSetFan(ROOM_KITCHEN, true);
  userSetLED(ROOM_BEDROOM, true);  userSetFan(ROOM_BEDROOM, true);  userSetAC(ROOM_BEDROOM, 100);
}

int main() {
  std::cout << "=== REPRO: อุปกรณ์เปิดหมด -> สลับ AUTO -> PIR LOW ตลอด ===\n\n";

  // ================= กรณี A: PIR อ่านได้ LOW จริง =================
  std::cout << "[A] PIR = LOW (ไม่มีคน) ตลอด\n";
  resetAll();
  turnEverythingOn();
  g_pinState[PIN_PIR_LIVING]  = LOW;
  g_pinState[PIN_PIR_KITCHEN] = LOW;
  g_pinState[PIN_PIR_BEDROOM] = LOW;

  check("ก่อนสลับ: ไฟ living เปิด", relayOn(PIN_LIVING_LED));
  check("ก่อนสลับ: แอร์ living เปิด", pwmDuty(PWM_CHANNEL_LIVING) == 255);

  setOperatingMode(true);
  runFor(6000);
  std::cout << "  -- ผ่าน 6 วินาที --\n";
  check("living LED ดับ",  relayOff(PIN_LIVING_LED));
  check("living Fan ดับ",  relayOff(PIN_LIVING_FAN));
  check("kitchen LED ดับ", relayOff(PIN_KITCHEN_LED));
  check("kitchen Fan ดับ", relayOff(PIN_KITCHEN_FAN));
  check("bedroom LED ดับ", relayOff(PIN_BEDROOM_LED));
  check("bedroom Fan ดับ", relayOff(PIN_BEDROOM_FAN));
  check("แอร์ยังเปิด (ยังไม่ถึง 10s)", pwmDuty(PWM_CHANNEL_LIVING) == 255);

  runFor(5000);
  std::cout << "  -- ผ่าน 11 วินาที --\n";
  check("living AC ดับ",  pwmDuty(PWM_CHANNEL_LIVING) == 0);
  check("bedroom AC ดับ", pwmDuty(PWM_CHANNEL_BEDROOM) == 0);

  // ================= กรณี B: PIR ค้าง HIGH =================
  // HC-SR501 มี hold time 2-8 วินาที และ GPIO 34/35/36 ไม่มี pull resistor ในตัว
  // ถ้าสายหลุด/ไฟไม่นิ่ง ขาอาจลอยอ่านเป็น HIGH ค้าง
  std::cout << "\n[B] PIR ค้าง HIGH (จำลองอาการที่รายงาน)\n";
  resetAll();
  turnEverythingOn();
  g_pinState[PIN_PIR_LIVING]  = HIGH;
  g_pinState[PIN_PIR_KITCHEN] = HIGH;
  g_pinState[PIN_PIR_BEDROOM] = HIGH;

  setOperatingMode(true);
  runFor(30000);
  std::cout << "  -- ผ่าน 30 วินาที --\n";

  bool nothingOff = relayOn(PIN_LIVING_LED) && relayOn(PIN_LIVING_FAN)
                 && relayOn(PIN_KITCHEN_LED) && relayOn(PIN_BEDROOM_LED)
                 && pwmDuty(PWM_CHANNEL_LIVING) == 255;
  check("PIR ค้าง HIGH -> ไม่มีอะไรดับ (= อาการที่เจอ)", nothingOff);

  // ================= กรณี C: ไม่ได้สลับโหมด =================
  std::cout << "\n[C] ยังเป็น MANUAL (จำลองว่าบอร์ดไม่ได้รับคำสั่งสลับโหมด)\n";
  resetAll();
  turnEverythingOn();
  g_pinState[PIN_PIR_LIVING] = LOW;
  runFor(30000);
  check("MANUAL -> ไม่มีอะไรดับ (= อาการที่เจอ)", relayOn(PIN_LIVING_LED));

  std::cout << "\n=== " << pass << " passed, " << fail << " failed ===\n";
  std::cout << "\nสรุป: ถ้า [A] ผ่านหมด = logic ถูก ปัญหาอยู่ที่ PIR อ่าน HIGH ([B])\n";
  std::cout << "      หรือบอร์ดไม่ได้เข้าโหมด AUTO ([C])\n";
  return fail == 0 ? 0 : 1;
}
