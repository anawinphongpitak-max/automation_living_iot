/*
 * พิมพ์ Serial output จริงของสถานการณ์ทดสอบที่รายงานมา
 *
 *   อุปกรณ์เปิดหมด -> สลับ AUTO -> PIR = NO MOTION -> 5s -> LED/FAN OFF -> 10s -> AC OFF
 *
 * ใช้ยืนยันว่าบนบอร์ดจริงควรเห็นอะไร ถ้าเห็นไม่ตรงนี้ = ปัญหาอยู่ที่ฮาร์ดแวร์
 *
 * build: g++ -std=c++17 -o serial_trace.exe serial_trace.cpp && ./serial_trace.exe
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

/** พิมพ์ Serial ที่สะสมไว้ พร้อม timestamp จำลอง */
void flushSerial() {
  for (auto& l : g_serialLines) std::cout << "  " << l << "\n";
  g_serialLines.clear();
}

void runFor(unsigned long ms) {
  for (unsigned long t = 0; t < ms; t += 50) {
    g_fakeMillis += 50;
    if (currentMode == MODE_AUTOMATIC) updateAutomaticMode();
  }
}

int main() {
  g_fakeMillis = 1000;
  currentMode = MODE_MANUAL;
  for (int i = 0; i < ROOM_COUNT; i++) {
    roomAuto[i] = RoomAuto{};
    roomAuto[i].lastMotion = g_fakeMillis;
  }

  // PIR ไม่เจอคนเลยตลอดการทดสอบ
  g_pinState[PIN_PIR_LIVING]  = LOW;
  g_pinState[PIN_PIR_KITCHEN] = LOW;
  g_pinState[PIN_PIR_BEDROOM] = LOW;

  std::cout << "===============================================\n";
  std::cout << " EXPECTED SERIAL OUTPUT (PIR = NO MOTION)\n";
  std::cout << "===============================================\n\n";

  std::cout << "--- 1) เปิดอุปกรณ์ทุกตัวด้วยมือ (MANUAL) ---\n";
  g_serialLines.clear();
  userSetLED(ROOM_LIVING, true);   userSetFan(ROOM_LIVING, true);   userSetAC(ROOM_LIVING, 100);
  userSetLED(ROOM_KITCHEN, true);  userSetFan(ROOM_KITCHEN, true);
  userSetLED(ROOM_BEDROOM, true);  userSetFan(ROOM_BEDROOM, true);  userSetAC(ROOM_BEDROOM, 100);
  flushSerial();

  std::cout << "\n--- 2) สลับ MANUAL -> AUTOMATIC ---\n";
  setOperatingMode(true);
  flushSerial();

  std::cout << "\n--- 3) รอ 1 วินาที ---\n";
  runFor(1000);
  flushSerial();

  std::cout << "\n--- 4) ถึง 5 วินาที (LED/FAN ต้องดับ) ---\n";
  runFor(4200);
  flushSerial();

  std::cout << "\n--- 5) ถึง 10 วินาที (AC ต้องดับ) ---\n";
  runFor(5000);
  flushSerial();

  std::cout << "\n===============================================\n";
  std::cout << " สถานะฮาร์ดแวร์สุดท้าย (relay active LOW)\n";
  std::cout << "===============================================\n";
  auto st = [](int pin) { return g_relayWrites.count(pin) && g_relayWrites[pin] == LOW ? "ON " : "OFF"; };
  std::cout << "  Living  LED=" << st(PIN_LIVING_LED)  << "  FAN=" << st(PIN_LIVING_FAN)
            << "  AC duty=" << g_pwmWrites[PWM_CHANNEL_LIVING] << "\n";
  std::cout << "  Kitchen LED=" << st(PIN_KITCHEN_LED) << "  FAN=" << st(PIN_KITCHEN_FAN)
            << "  (ไม่มี AC)\n";
  std::cout << "  Bedroom LED=" << st(PIN_BEDROOM_LED) << "  FAN=" << st(PIN_BEDROOM_FAN)
            << "  AC duty=" << g_pwmWrites[PWM_CHANNEL_BEDROOM] << "\n";
  std::cout << "  Door relay แตะหรือไม่: "
            << (g_relayWrites.count(PIN_DOOR_LOCK) ? "แตะ (ผิด!)" : "ไม่แตะ (ถูก)") << "\n";
  return 0;
}
