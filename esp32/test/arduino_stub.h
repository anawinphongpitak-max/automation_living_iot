/*
 * Arduino API stubs - ใช้ compile logic ของ automatic mode บน PC
 * เพื่อทดสอบพฤติกรรมโดยไม่ต้องมีบอร์ดจริง
 */
#ifndef ARDUINO_STUB_H
#define ARDUINO_STUB_H

#include <string>
#include <cstdio>
#include <vector>
#include <map>

#define HIGH 1
#define LOW  0
#define INPUT 0
#define OUTPUT 1

typedef std::string String;

// ---------- เวลาปลอม คุมได้จากเทส ----------
extern unsigned long g_fakeMillis;
inline unsigned long millis() { return g_fakeMillis; }

// ---------- PIR ปลอม ----------
extern std::map<int, int> g_pinState;
inline int digitalRead(int pin) { return g_pinState.count(pin) ? g_pinState[pin] : LOW; }

// ---------- บันทึกทุกครั้งที่เขียน relay / PWM ----------
extern std::map<int, int> g_relayWrites;   // pin -> ค่าล่าสุด (LOW=ON)
extern std::map<int, int> g_pwmWrites;     // channel -> duty
inline void digitalWrite(int pin, int val) { g_relayWrites[pin] = val; }
inline void ledcWrite(int ch, int duty) { g_pwmWrites[ch] = duty; }
inline void pinMode(int, int) {}

// ---------- Serial ----------
extern std::vector<std::string> g_serialLines;
struct SerialStub {
  std::string buf;
  void print(const char* s) { buf += s; }
  void print(const std::string& s) { buf += s; }
  void print(int v) { buf += std::to_string(v); }
  void print(unsigned long v) { buf += std::to_string(v); }
  void print(long v) { buf += std::to_string(v); }
  void println() { g_serialLines.push_back(buf); buf.clear(); }
  void println(const char* s) { buf += s; println(); }
  void println(const std::string& s) { buf += s; println(); }
  void println(int v) { buf += std::to_string(v); println(); }
  void println(unsigned long v) { buf += std::to_string(v); println(); }
  void begin(int) {}
};
extern SerialStub Serial;

inline int constrain(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

#endif
