/*
 * Smart Home IoT System - Complete Multi-Room Control
 * ESP32 DevKit V1
 *
 * GPIO Mapping:
 * GPIO 5  → Living AC (JZ-MOS1 PWM)
 * GPIO 13 → Door Lock (Relay IN8 - Active LOW)
 * GPIO 14 → Living LED (Relay IN7 - Active LOW)
 * GPIO 16 → AS608 Fingerprint RX (UART2)
 * GPIO 17 → AS608 Fingerprint TX (UART2)
 * GPIO 18 → Bedroom Fan (Relay IN2 - Active LOW)
 * GPIO 19 → DHT22 Data
 * GPIO 21 → Bedroom AC (JZ-MOS2 PWM)
 * GPIO 22 → Kitchen Window (180° Servo)
 * GPIO 25 → Living Exhaust Fan (Relay IN4 - Active LOW)
 * GPIO 26 → Bedroom LED (Relay IN5 - Active LOW)
 * GPIO 27 → Kitchen LED (Relay IN6 - Active LOW)
 * GPIO 32 → Bedroom Window (180° Servo)
 * GPIO 33 → Kitchen Exhaust Fan (Relay IN3 - Active LOW)
 * GPIO 34 → PIR Living (Input only)
 * GPIO 35 → PIR Bedroom (Input only)
 * GPIO 36 → PIR Kitchen (Input only)
 *
 * MQTT Topics:
 * Subscribe (Commands):
 *   home/control/door
 *   home/control/living/led
 *   home/control/living/fan
 *   home/control/living/ac
 *   home/control/kitchen/led
 *   home/control/kitchen/fan
 *   home/control/kitchen/window
 *   home/control/bedroom/led
 *   home/control/bedroom/fan
 *   home/control/bedroom/ac
 *   home/control/bedroom/window
 *   home/control/auto              {"mode":"on"|"off"}  Manual / Automatic mode
 *   home/control/auto/settings     {"lightFanTimeout":5,"acTimeout":10}  วินาที - ปรับ timeout runtime
 *
 * Publish (Status/Sensors):
 *   home/sensor/dht22
 *   home/sensor/pir/living
 *   home/sensor/pir/kitchen
 *   home/sensor/pir/bedroom
 *   home/sensor/fingerprint
 *   home/status/door
 *   home/status/living
 *   home/status/kitchen
 *   home/status/bedroom
 *   home/status/mode               {"mode":"on"|"off"}  โหมดที่ทำงานอยู่จริง
 *   home/status/auto/settings      {"lightFanTimeout":5,"acTimeout":10}  วินาที - ค่าจริงบนบอร์ดตอนนี้
 *   home/status/pir                {"living":true,"kitchen":false,"bedroom":true}  publish เฉพาะตอนเปลี่ยนค่า + ครั้งแรกหลัง connect
 *   home/debug/log                 {"message":"...","timestamp":millis()}  Automatic Mode debug telemetry (optional, non-blocking)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <Adafruit_Fingerprint.h>
#include "secrets.h"

// ===== WiFi & MQTT Configuration =====
// Credentials moved to secrets.h (not tracked by Git)
const int   MQTT_PORT   = 8883;

// ===== GPIO Pin Definitions =====
// Relays (Active LOW: LOW=ON, HIGH=OFF)
#define PIN_DOOR_LOCK       13
#define PIN_LIVING_LED      14
#define PIN_LIVING_FAN      25
#define PIN_KITCHEN_LED     27
#define PIN_KITCHEN_FAN     33
#define PIN_BEDROOM_LED     26
#define PIN_BEDROOM_FAN     18

// AC PWM
#define PIN_LIVING_AC       5
#define PIN_BEDROOM_AC      21

// Servos
#define PIN_KITCHEN_WINDOW  4   // 180°
#define PIN_BEDROOM_WINDOW  32  // 180°

// Sensors
#define PIN_DHT22           19
#define DHT_TYPE            DHT22
#define PIN_PIR_LIVING      34  // Input only
#define PIN_PIR_BEDROOM     35  // Input only
#define PIN_PIR_KITCHEN     36  // Input only

// Fingerprint (UART2)
#define PIN_AS608_RX        16
#define PIN_AS608_TX        17

// ===== PWM Configuration =====
#define PWM_FREQ            1000
#define PWM_RESOLUTION      8
#define PWM_CHANNEL_LIVING  12
#define PWM_CHANNEL_BEDROOM 13

// ===== Objects =====
WiFiClientSecure wifiClient;
PubSubClient mqtt(wifiClient);
DHT dht(PIN_DHT22, DHT_TYPE);

Servo servoKitchenWindow;
Servo servoBedroomWindow;

Adafruit_Fingerprint finger = Adafruit_Fingerprint(&Serial2);

// ===== State Variables =====
bool doorLocked = true;

bool livingLED = false;
bool livingFan = false;
int  livingAC  = 0;

bool kitchenLED = false;
bool kitchenFan = false;
int  kitchenWindow = 45;

bool bedroomLED = false;
bool bedroomFan = false;
int  bedroomAC  = 0;
int  bedroomWindow = 0;

unsigned long lastSensor = 0;
unsigned long lastStatus = 0;
const long SENSOR_INTERVAL = 2000;
const long STATUS_INTERVAL = 5000;

bool kitchenServoAttached = false;

// Fingerprint state tracking
bool fingerDetected = false;
bool fingerprintProcessing = false;

// Fingerprint enrollment state machine
enum FingerprintEnrollState {
  FP_ENROLL_IDLE,
  FP_ENROLL_WAIT_FIRST_FINGER,
  FP_ENROLL_CAPTURE_FIRST,
  FP_ENROLL_WAIT_REMOVE_FIRST,
  FP_ENROLL_WAIT_SECOND_FINGER,
  FP_ENROLL_CAPTURE_SECOND,
  FP_ENROLL_CREATE_MODEL,
  FP_ENROLL_STORE_MODEL,
  FP_ENROLL_SUCCESS,
  FP_ENROLL_FAILED
};

bool fingerprintEnrollmentActive = false;
uint16_t enrollingFingerprintId = 0;
FingerprintEnrollState fingerprintEnrollState = FP_ENROLL_IDLE;
unsigned long enrollmentStateStartTime = 0;

/* =====================================================
   PIR STATUS BROADCAST (additive, ไม่แตะ automation logic)
   อ่าน GPIO ตรงๆ แยกจาก lastMotion/updateAutomaticMode ทั้งหมด
   publish home/status/pir เฉพาะตอนค่าเปลี่ยน + ครั้งแรกหลัง connect
===================================================== */
bool prevPirLiving  = false;
bool prevPirKitchen = false;
bool prevPirBedroom = false;
bool pirStatusInitialized = false;

/* =====================================================
   MANUAL / AUTOMATIC MODE  (Phase 1)

   Manual    = ผู้ใช้คุมเองทั้งหมด PIR ไม่แตะอุปกรณ์ (พฤติกรรมเดิม)
   Automatic = ไม่มีคนในห้องนานเกินกำหนด -> ปิดอุปกรณ์ของห้องนั้น
               พอมีคนกลับมา -> คืนค่าตามที่ผู้ใช้ตั้งไว้ล่าสุด

   หมายเหตุ: ประตู, หน้าต่าง ไม่อยู่ใน automatic mode
===================================================== */

enum OperatingMode {
  MODE_MANUAL,
  MODE_AUTOMATIC
};

OperatingMode currentMode = MODE_MANUAL;

// ===== TEST MODE timers - ค่าจริงตอนส่งงานคือ 45000 / 90000 =====
// แปลงจาก const เป็นตัวแปร runtime เพื่อให้ Dashboard สั่งเปลี่ยนผ่าน MQTT ได้
// โดยไม่ต้องอัปโหลดเฟิร์มแวร์ใหม่ - ค่าเริ่มต้นยังเป็นค่าเดิมทุกประการ
// checkRoomInactivity() ยังใช้ตัวแปรนี้เหมือนเดิมทุกจุด ไม่แก้ logic การเทียบเวลา
unsigned long autoLightFanTimeout = 5000;   // ไฟ + พัดลม (ms)
unsigned long autoACTimeout       = 10000;  // แอร์จำลอง (ms)

// ห้องที่มี automatic logic - index ใช้ร่วมกันทุก array ด้านล่าง
enum RoomIndex {
  ROOM_LIVING,
  ROOM_KITCHEN,
  ROOM_BEDROOM,
  ROOM_COUNT
};

const char* ROOM_NAMES[ROOM_COUNT] = { "Living Room", "Kitchen", "Bedroom" };
const int   ROOM_PIR_PINS[ROOM_COUNT] = { PIN_PIR_LIVING, PIN_PIR_KITCHEN, PIN_PIR_BEDROOM };

/*
 * แยก "สิ่งที่ผู้ใช้สั่งไว้" ออกจาก "สิ่งที่ฮาร์ดแวร์เป็นอยู่จริง"
 *
 * userLED/userFan/userAC = ความตั้งใจของผู้ใช้ (source of truth สำหรับการคืนค่า)
 * livingLED/livingFan/livingAC ฯลฯ = สถานะจริงของ relay/PWM ตอนนี้
 *
 * ตอน auto ปิดอุปกรณ์ เราแตะแค่สถานะจริง ไม่แตะ user state
 * ทำให้คืนค่าได้ถูกต้องตอนมีคนกลับมา
 *
 * flag 2 ชุดแยกหน้าที่กัน:
 *   lightFanTimerFired / acTimerFired = latch ว่ารอบเงียบนี้สั่งปิดไปแล้ว
 *       รีเซ็ตเมื่อมีคนกลับมาเท่านั้น กัน auto ปิดซ้ำทุก loop และกัน
 *       auto แย่งปิดถ้าผู้ใช้กดเปิดเองตอนห้องยังเงียบ
 *   ledShutdown / fanShutdown / acShutdown = อุปกรณ์ชิ้นนี้ถูก auto ปิด
 *       และรอคืนค่า ถ้าผู้ใช้สั่งชิ้นนั้นเองก็เคลียร์ flag (คำสั่งใหม่ชนะ)
 */
struct RoomAuto {
  unsigned long lastMotion;    // ครั้งสุดท้ายที่ PIR เจอคน
  bool lightFanTimerFired;     // รอบนี้สั่งปิดไฟ+พัดลมไปแล้ว
  bool acTimerFired;           // รอบนี้สั่งปิดแอร์ไปแล้ว
  bool ledShutdown;            // ไฟถูก auto ปิดและรอคืนค่า
  bool fanShutdown;            // พัดลมถูก auto ปิดและรอคืนค่า
  bool acShutdown;             // แอร์ถูก auto ปิดและรอคืนค่า
  bool lastPirState;           // ใช้จับขอบขา 0->1 ไม่ให้ log ท่วม
  bool userLED;                // ค่าที่ผู้ใช้ตั้งไว้
  bool userFan;
  int  userAC;                 // 0 / 70 / 90 / 100
};

RoomAuto roomAuto[ROOM_COUNT];

// พิมพ์เวลานับถอยของแต่ละห้องทุก 1 วินาที (ไม่ใช่ทุก loop) เพื่อ debug ฮาร์ดแวร์
unsigned long lastAutoDebug = 0;
const unsigned long AUTO_DEBUG_INTERVAL = 1000;

// ===== Forward declarations =====
void publishStatusDoor();
void publishStatusLiving();
void publishStatusKitchen();
void publishStatusBedroom();
void publishStatusMode();
void publishStatusAutoSettings();
void checkAndPublishPIRStatus();
void publishDebugLog(String message);
void publishRoomStatus(RoomIndex room);
void applyRoomLED(RoomIndex room, bool on);
void applyRoomFan(RoomIndex room, bool on);
void applyRoomAC(RoomIndex room, int level);
void setOperatingMode(bool automatic);
void handleRoomMotion(RoomIndex room);
void checkRoomInactivity(RoomIndex room, unsigned long now);
void autoShutdownLightFan(RoomIndex room);
void autoShutdownAC(RoomIndex room);
void restoreRoomState(RoomIndex room);
void updateAutomaticMode();
void restartAutoTimerForUserCommand(RoomIndex room);

// Fingerprint
void checkFingerprint();

// ===== Helper Functions =====
void setRelay(int pin, bool on) {
  digitalWrite(pin, on ? LOW : HIGH);  // Active LOW
}

void setAC(int channel, int level) {
  // level: 0, 70, 90, 100
  int duty = 0;
  if (level == 70)       duty = 179;  // ~70% of 255
  else if (level == 90)  duty = 230;  // ~90% of 255
  else if (level == 100) duty = 255;  // 100%
  ledcWrite(channel, duty);

  // Diagnostic output
  Serial.print("[AC] Channel ");
  Serial.print(channel);
  Serial.print(" Level: ");
  Serial.print(level);
  Serial.print("% Duty: ");
  Serial.print(duty);
  Serial.println(" / 255");
}

/* =====================================================
   ROOM DEVICE HELPERS

   เขียนสถานะจริงลงฮาร์ดแวร์ตาม room index โดยไม่แตะ user state
   ใช้ทั้งจากคำสั่งผู้ใช้ (MQTT) และจาก automatic mode
===================================================== */

void applyRoomLED(RoomIndex room, bool on) {
  switch (room) {
    case ROOM_LIVING:  livingLED  = on; setRelay(PIN_LIVING_LED, on);  break;
    case ROOM_KITCHEN: kitchenLED = on; setRelay(PIN_KITCHEN_LED, on); break;
    case ROOM_BEDROOM: bedroomLED = on; setRelay(PIN_BEDROOM_LED, on); break;
    default: break;
  }
}

void applyRoomFan(RoomIndex room, bool on) {
  switch (room) {
    case ROOM_LIVING:  livingFan  = on; setRelay(PIN_LIVING_FAN, on);  break;
    case ROOM_KITCHEN: kitchenFan = on; setRelay(PIN_KITCHEN_FAN, on); break;
    case ROOM_BEDROOM: bedroomFan = on; setRelay(PIN_BEDROOM_FAN, on); break;
    default: break;
  }
}

// ครัวไม่มีแอร์ - เรียกแล้วไม่ทำอะไร
void applyRoomAC(RoomIndex room, int level) {
  switch (room) {
    case ROOM_LIVING:  livingAC  = level; setAC(PWM_CHANNEL_LIVING, level);  break;
    case ROOM_BEDROOM: bedroomAC = level; setAC(PWM_CHANNEL_BEDROOM, level); break;
    default: break;
  }
}

bool roomHasAC(RoomIndex room) {
  return room == ROOM_LIVING || room == ROOM_BEDROOM;
}

void publishRoomStatus(RoomIndex room) {
  switch (room) {
    case ROOM_LIVING:  publishStatusLiving();  break;
    case ROOM_KITCHEN: publishStatusKitchen(); break;
    case ROOM_BEDROOM: publishStatusBedroom(); break;
    default: break;
  }
}

/* =====================================================
   AUTOMATIC MODE ENGINE
===================================================== */

/*
 * สลับโหมด - ไม่แตะสถานะอุปกรณ์ทันทีทั้งสองทาง
 *
 * เข้า automatic : เริ่มนับเวลาใหม่ทุกห้อง รอครบ timeout ก่อนปิด
 * ออกไป manual   : หยุดนับ ปล่อยอุปกรณ์ไว้ตามที่เป็น ไม่คืนค่าย้อนหลัง
 */
void setOperatingMode(bool automatic) {
  Serial.println("[AUTO DEBUG] setOperatingMode() CALLED");
  OperatingMode next = automatic ? MODE_AUTOMATIC : MODE_MANUAL;
  Serial.print("[AUTO DEBUG] Previous mode: ");
  Serial.println(currentMode == MODE_AUTOMATIC ? "AUTOMATIC" : "MANUAL");
  Serial.print("[AUTO DEBUG] New mode: ");
  Serial.println(next == MODE_AUTOMATIC ? "AUTOMATIC" : "MANUAL");

  if (next == currentMode) {
    Serial.println("[AUTO DEBUG] Mode unchanged - re-publishing status only");
    publishStatusMode();   // ตอบกลับเสมอ ให้ dashboard sync ได้แม้ค่าไม่เปลี่ยน
    return;
  }

  currentMode = next;
  unsigned long now = millis();

  if (currentMode == MODE_AUTOMATIC) {
    Serial.println("[MODE] Automatic enabled");
    publishDebugLog("[AUTO MODE] Enabled");

    /*
     * เริ่มจับเวลาทันทีตอนเข้าโหมด ไม่รอให้ PIR ขึ้น HIGH ก่อน
     *
     * PIR LOW  (ไม่มีคน) -> lastMotion = now แล้วเริ่มนับเลย
     * PIR HIGH (มีคน)    -> lastMotion = now เหมือนกัน แต่ถือเป็น motion จริง
     *                       การนับจะถูกรีเซ็ตต่อเนื่องจนคนออกจากห้อง
     */
    for (int i = 0; i < ROOM_COUNT; i++) {
      RoomIndex room = (RoomIndex)i;
      bool motion = digitalRead(ROOM_PIR_PINS[i]) == HIGH;

      roomAuto[i].lastMotion = now;
      roomAuto[i].lastPirState = motion;
      roomAuto[i].lightFanTimerFired = false;
      roomAuto[i].acTimerFired = false;
      roomAuto[i].ledShutdown = false;
      roomAuto[i].fanShutdown = false;
      roomAuto[i].acShutdown = false;

      Serial.print("[AUTO] ");
      Serial.print(ROOM_NAMES[room]);
      Serial.print(" PIR: ");
      Serial.println(motion ? "MOTION" : "NO MOTION");

      Serial.print("[AUTO TIMER] ");
      Serial.print(ROOM_NAMES[room]);
      Serial.println(" started");
    }

    lastAutoDebug = now;

    Serial.print("[AUTO MODE] Light/Fan timeout ");
    Serial.print(autoLightFanTimeout / 1000);
    Serial.print("s, AC timeout ");
    Serial.print(autoACTimeout / 1000);
    Serial.println("s");
  } else {
    Serial.println("[AUTO MODE] Disabled");
  }

  publishStatusMode();
}

/*
 * PIR เจอคนในห้อง - อัปเดตเวลา และคืนค่าถ้าเคยถูก auto ปิดไว้
 */
void handleRoomMotion(RoomIndex room) {
  RoomAuto &r = roomAuto[room];
  r.lastMotion = millis();

  // มีคนกลับมา - เริ่มนับรอบใหม่ได้
  r.lightFanTimerFired = false;
  r.acTimerFired = false;

  if (r.ledShutdown || r.fanShutdown || r.acShutdown) {
    Serial.print("[AUTO] Motion returned in ");
    Serial.println(ROOM_NAMES[room]);
    Serial.println("[AUTO] Restoring user device states");
    restoreRoomState(room);
  }
}

/*
 * คืนค่าตามที่ผู้ใช้ตั้งไว้ล่าสุด - ไม่ใช่เปิดทุกอย่าง
 * ถ้าผู้ใช้ตั้งไว้ว่าปิด ก็ยังปิดต่อ
 * คืนเฉพาะอุปกรณ์ที่ auto ปิดไว้ ชิ้นที่ผู้ใช้สั่งเองระหว่างนั้นไม่ถูกแตะ
 */
void restoreRoomState(RoomIndex room) {
  RoomAuto &r = roomAuto[room];

  if (r.ledShutdown) {
    applyRoomLED(room, r.userLED);
    r.ledShutdown = false;
    publishDebugLog(String("[AUTO RESTORE] ") + ROOM_NAMES[room] + " restoring LED -> " + (r.userLED ? "ON" : "OFF"));
  }

  if (r.fanShutdown) {
    applyRoomFan(room, r.userFan);
    r.fanShutdown = false;
    publishDebugLog(String("[AUTO RESTORE] ") + ROOM_NAMES[room] + " restoring FAN -> " + (r.userFan ? "ON" : "OFF"));
  }

  if (r.acShutdown) {
    if (roomHasAC(room)) {
      applyRoomAC(room, r.userAC);
      publishDebugLog(String("[AUTO RESTORE] ") + ROOM_NAMES[room] + " restoring AC -> " + r.userAC);
    }
    r.acShutdown = false;
  }

  publishRoomStatus(room);
}

/*
 * ผู้ใช้สั่งอุปกรณ์เองระหว่าง AUTOMATIC - ไม่ใช่ PIR เจอคน
 * รีสตาร์ทนับเวลาห้องนั้นใหม่เท่านั้น ไม่เรียก handleRoomMotion()/restoreRoomState()
 * และไม่แตะห้องอื่น เพื่อให้ auto ปิดซ้ำได้อีกครั้งถ้ายังไม่มีคนกลับมาจริง
 */
void restartAutoTimerForUserCommand(RoomIndex room) {
  if (currentMode != MODE_AUTOMATIC) return;

  roomAuto[room].lastMotion = millis();
  roomAuto[room].lightFanTimerFired = false;
  roomAuto[room].acTimerFired = false;
}

void autoShutdownLightFan(RoomIndex room) {
  Serial.print("[AUTO DEBUG] Calling autoShutdownLightFan() for ");
  Serial.println(ROOM_NAMES[room]);

  RoomAuto &r = roomAuto[room];
  r.lightFanTimerFired = true;
  r.ledShutdown = true;
  r.fanShutdown = true;

  Serial.print("[AUTO DEBUG] autoShutdownLightFan() EXECUTING for ");
  Serial.println(ROOM_NAMES[room]);

  Serial.print("[AUTO] ");
  Serial.print(ROOM_NAMES[room]);
  Serial.print(" inactive for ");
  Serial.print(autoLightFanTimeout / 1000);
  Serial.println(" seconds");

  applyRoomLED(room, false);
  publishDebugLog(String("[AUTO SHUTDOWN] ") + ROOM_NAMES[room] + " LED OFF");

  applyRoomFan(room, false);
  publishDebugLog(String("[AUTO SHUTDOWN] ") + ROOM_NAMES[room] + " FAN OFF");

  publishRoomStatus(room);
}

void autoShutdownAC(RoomIndex room) {
  Serial.print("[AUTO DEBUG] Calling autoShutdownAC() for ");
  Serial.println(ROOM_NAMES[room]);

  RoomAuto &r = roomAuto[room];
  r.acTimerFired = true;
  r.acShutdown = true;

  Serial.print("[AUTO DEBUG] autoShutdownAC() EXECUTING for ");
  Serial.println(ROOM_NAMES[room]);

  Serial.print("[AUTO] ");
  Serial.print(ROOM_NAMES[room]);
  Serial.print(" inactive for ");
  Serial.print(autoACTimeout / 1000);
  Serial.println(" seconds");

  applyRoomAC(room, 0);
  publishDebugLog(String("[AUTO SHUTDOWN] ") + ROOM_NAMES[room] + " AC OFF");

  publishRoomStatus(room);
}

/*
 * ตรวจว่าห้องนี้เงียบนานพอจะปิดอะไรหรือยัง
 * ปิดครั้งเดียวต่อรอบ - flag กันสั่งซ้ำทุก loop
 */
void checkRoomInactivity(RoomIndex room, unsigned long now) {
  RoomAuto &r = roomAuto[room];
  unsigned long idle = now - r.lastMotion;

  // latch แยกจาก flag รอคืนค่า - ปิดครั้งเดียวต่อรอบเงียบ
  // ถ้าผู้ใช้กดเปิดเองตอนห้องยังเงียบ auto จะไม่ไปปิดซ้ำ
  if (!r.lightFanTimerFired && idle >= autoLightFanTimeout) {
    publishDebugLog(String("[AUTO TIMEOUT] ") + ROOM_NAMES[room] + " LIGHT/FAN timeout reached");

    Serial.print("[AUTO DEBUG] Calling autoShutdownLightFan() for ");
    Serial.println(ROOM_NAMES[room]);
    autoShutdownLightFan(room);
  }

  if (!r.acTimerFired && roomHasAC(room) && idle >= autoACTimeout) {
    publishDebugLog(String("[AUTO TIMEOUT] ") + ROOM_NAMES[room] + " AC timeout reached");

    Serial.print("[AUTO DEBUG] Calling autoShutdownAC() for ");
    Serial.println(ROOM_NAMES[room]);
    autoShutdownAC(room);
  }
}

/*
 * เรียกทุก loop - อ่าน PIR แล้วตัดสินใจ
 * ทำงานเฉพาะตอน MODE_AUTOMATIC
 */
void updateAutomaticMode() {
  if (currentMode != MODE_AUTOMATIC) return;

  unsigned long now = millis();

  // พิมพ์เวลานับถอยทุก 1 วินาที - ใช้ยืนยันว่าตัวนับเดินจริงบนบอร์ด
  bool printDebug = (now - lastAutoDebug >= AUTO_DEBUG_INTERVAL);
  if (printDebug) lastAutoDebug = now;

  for (int i = 0; i < ROOM_COUNT; i++) {
    RoomIndex room = (RoomIndex)i;
    RoomAuto &r = roomAuto[i];

    bool motion = digitalRead(ROOM_PIR_PINS[i]) == HIGH;

    if (printDebug) {
      Serial.print("[AUTO DEBUG] ");
      Serial.print(ROOM_NAMES[room]);
      Serial.print(" inactivity: ");
      Serial.print(motion ? 0UL : (unsigned long)(now - r.lastMotion));
      Serial.print(" ms  (PIR ");
      Serial.print(motion ? "MOTION" : "NO MOTION");
      Serial.println(")");

      if (!motion) {
        unsigned long idleSeconds = (now - r.lastMotion) / 1000;
        publishDebugLog(String("[AUTO TIMER] ") + ROOM_NAMES[room] + " inactivity: " + idleSeconds + "s");
      }
    }

    if (motion) {
      // จับเฉพาะขอบขา (ไม่มีคน -> มีคน) เพื่อไม่ให้ log ท่วม
      if (!r.lastPirState) {
        Serial.print("[PIR] ");
        Serial.print(ROOM_NAMES[room]);
        Serial.println(" Motion Detected");

        publishDebugLog(String("[AUTO PIR] ") + ROOM_NAMES[room] + " MOTION DETECTED");
      }
      handleRoomMotion(room);
    } else {
      // จับเฉพาะขอบขา (มีคน -> ไม่มีคน) เพื่อบอกว่า timer เพิ่งเริ่มนับจริง
      if (r.lastPirState) {
        publishDebugLog(String("[AUTO PIR] ") + ROOM_NAMES[room] + " NO MOTION");
        publishDebugLog(String("[AUTO TIMER] ") + ROOM_NAMES[room] + " timer started");
      }
      checkRoomInactivity(room, now);
    }

    r.lastPirState = motion;
  }
}



/* =====================================================
   USER COMMANDS

   คำสั่งจากผู้ใช้มาก่อนเสมอ - อัปเดตทั้งสถานะจริงและ user state
   แล้วยกเลิก flag auto shutdown ของอุปกรณ์ชิ้นนั้น เพื่อไม่ให้
   automatic mode เอาค่าเก่ามาทับคำสั่งใหม่ตอนมีคนกลับมา
===================================================== */

void userSetLED(RoomIndex room, bool on) {
  roomAuto[room].userLED = on;
  // ผู้ใช้สั่งเองแล้ว ยกเลิกการคืนค่าเฉพาะไฟ (พัดลม/แอร์ยังรอคืนค่าได้)
  roomAuto[room].ledShutdown = false;
  restartAutoTimerForUserCommand(room);
  applyRoomLED(room, on);
  publishRoomStatus(room);
}

void userSetFan(RoomIndex room, bool on) {
  roomAuto[room].userFan = on;
  roomAuto[room].fanShutdown = false;
  restartAutoTimerForUserCommand(room);
  applyRoomFan(room, on);
  publishRoomStatus(room);
}

void userSetAC(RoomIndex room, int level) {
  roomAuto[room].userAC = level;
  roomAuto[room].acShutdown = false;
  restartAutoTimerForUserCommand(room);
  applyRoomAC(room, level);
  publishRoomStatus(room);
}

// ===== MQTT Callback =====
void onMessage(char* topic, byte* payload, unsigned int len) {
  String msg;
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];

  String t = String(topic);

  // พิมพ์ทุกข้อความที่เข้ามาก่อน parse/filter ใดๆ - ถ้า JSON พังก็ยังเห็นว่า
  // message มาถึงจริง (ของเดิมพิมพ์หลัง parse ผ่าน ทำให้ JSON พังแล้วดูเหมือนไม่มาถึง)
  Serial.print("[MQTT RX] Topic: ");
  Serial.println(t);
  Serial.print("[MQTT RX] Payload: ");
  Serial.println(msg);

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, msg)) {
    Serial.println("[MQTT] JSON parse error");
    return;
  }

  Serial.print("[MQTT] ");
  Serial.print(t);
  Serial.print(" -> ");
  Serial.println(msg);

  // Door
  if (t == "home/control/door") {
    doorLocked = doc["locked"] | true;
    setRelay(PIN_DOOR_LOCK, !doorLocked);  // Inverted: unlocked=ON=LOW
    publishStatusDoor();
  }
  // Mode switch (Manual / Automatic)
  else if (t == "home/control/auto") {
    Serial.println("[AUTO DEBUG] AUTO COMMAND RECEIVED");
    const char* mode = doc["mode"] | "off";
    Serial.print("[AUTO DEBUG] Parsed mode: ");
    Serial.println(mode);
    setOperatingMode(String(mode) == "on");
  }
  // Automatic Mode timeout settings (runtime-configurable, ไม่แตะ mode/PIR/room state)
  else if (t == "home/control/auto/settings") {
    long lf = doc["lightFanTimeout"] | -1;
    long ac = doc["acTimeout"] | -1;

    bool lfValid = (lf >= 1 && lf <= 300);
    bool acValid = (ac >= 1 && ac <= 600);

    if (lfValid) {
      autoLightFanTimeout = (unsigned long)lf * 1000UL;
      Serial.print("[AUTO SETTINGS] Light/Fan Timeout: ");
      Serial.print(lf);
      Serial.println(" seconds");
    } else {
      Serial.print("[AUTO SETTINGS] Rejected invalid lightFanTimeout: ");
      Serial.println(lf);
    }

    if (acValid) {
      autoACTimeout = (unsigned long)ac * 1000UL;
      Serial.print("[AUTO SETTINGS] AC Timeout: ");
      Serial.print(ac);
      Serial.println(" seconds");
    } else {
      Serial.print("[AUTO SETTINGS] Rejected invalid acTimeout: ");
      Serial.println(ac);
    }

    publishStatusAutoSettings();
  }
  // Living Room
  else if (t == "home/control/living/led") {
    userSetLED(ROOM_LIVING, doc["state"] | false);
  }
  else if (t == "home/control/living/fan") {
    userSetFan(ROOM_LIVING, doc["state"] | false);
  }
  else if (t == "home/control/living/ac") {
    userSetAC(ROOM_LIVING, doc["level"] | 0);
  }
  // Kitchen
  else if (t == "home/control/kitchen/led") {
    userSetLED(ROOM_KITCHEN, doc["state"] | false);
  }
  else if (t == "home/control/kitchen/fan") {
    userSetFan(ROOM_KITCHEN, doc["state"] | false);
  }
  else if (t == "home/control/kitchen/window") {
    Serial.println("[KITCHEN SERVO] MQTT COMMAND RECEIVED");
    kitchenWindow = constrain((int)doc["angle"], 45, 160);

    // Attach Kitchen Servo only after an explicit command.
    if (!kitchenServoAttached) {
      servoKitchenWindow.attach(PIN_KITCHEN_WINDOW, 500, 2400);
      kitchenServoAttached = true;
    }

    servoKitchenWindow.write(kitchenWindow);
    publishStatusKitchen();
  }
  // Bedroom
  else if (t == "home/control/bedroom/led") {
    userSetLED(ROOM_BEDROOM, doc["state"] | false);
  }
  else if (t == "home/control/bedroom/fan") {
    userSetFan(ROOM_BEDROOM, doc["state"] | false);
  }
  else if (t == "home/control/bedroom/ac") {
    userSetAC(ROOM_BEDROOM, doc["level"] | 0);
  }
  else if (t == "home/control/bedroom/window") {
    bedroomWindow = constrain((int)doc["angle"], 0, 130);
    servoBedroomWindow.write(130 - bedroomWindow);
    publishStatusBedroom();
  }
  // Fingerprint enrollment control
  else if (t == "home/control/fingerprint/enroll") {
    const char* action = doc["action"];

    if (action && strcmp(action, "start") == 0) {
      uint16_t fpId = doc["fingerprintId"] | 0;

      if (fpId == 0 || fpId > 127) {
        Serial.println("[FINGERPRINT ENROLL] Invalid fingerprint ID");
        StaticJsonDocument<128> doc;
        doc["status"] = "failed";
        doc["fingerprintId"] = fpId;
        doc["error"] = "Invalid fingerprint ID (must be 1-127)";
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/status/fingerprint/enrollment", out.c_str());
        return;
      }

      if (fingerprintEnrollmentActive) {
        Serial.println("[FINGERPRINT ENROLL] Enrollment already active");
        return;
      }

      Serial.print("[FINGERPRINT ENROLL] Starting enrollment for ID: ");
      Serial.println(fpId);

      fingerprintEnrollmentActive = true;
      enrollingFingerprintId = fpId;
      fingerprintEnrollState = FP_ENROLL_WAIT_FIRST_FINGER;
      enrollmentStateStartTime = millis();

      StaticJsonDocument<64> statusDoc;
      statusDoc["status"] = "started";
      statusDoc["fingerprintId"] = fpId;
      String out;
      serializeJson(statusDoc, out);
      mqtt.publish("home/status/fingerprint/enrollment", out.c_str());

    } else if (action && strcmp(action, "cancel") == 0) {
      if (fingerprintEnrollmentActive) {
        Serial.println("[FINGERPRINT ENROLL] Cancelled");

        StaticJsonDocument<64> statusDoc;
        statusDoc["status"] = "cancelled";
        statusDoc["fingerprintId"] = enrollingFingerprintId;
        String out;
        serializeJson(statusDoc, out);
        mqtt.publish("home/status/fingerprint/enrollment", out.c_str());

        fingerprintEnrollmentActive = false;
        fingerprintEnrollState = FP_ENROLL_IDLE;
        enrollingFingerprintId = 0;
      }
    }
  }
  // Fingerprint deletion control
  else if (t == "home/control/fingerprint/delete") {
    const char* action = doc["action"];

    if (action && strcmp(action, "delete") == 0) {
      uint16_t fpId = doc["fingerprintId"] | 0;

      // Validate fingerprint ID
      if (fpId == 0 || fpId > 127) {
        Serial.println("[FINGERPRINT DELETE] Invalid fingerprint ID");
        StaticJsonDocument<128> doc;
        doc["status"] = "failed";
        doc["fingerprintId"] = fpId;
        doc["error"] = "Invalid fingerprint ID (must be 1-127)";
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/status/fingerprint/deletion", out.c_str());
        return;
      }

      // Protect Fingerprint ID 1 (Primary Administrator)
      if (fpId == 1) {
        Serial.println("[FINGERPRINT DELETE] Cannot delete primary administrator");
        StaticJsonDocument<128> doc;
        doc["status"] = "failed";
        doc["fingerprintId"] = fpId;
        doc["error"] = "Primary Administrator fingerprint cannot be deleted";
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/status/fingerprint/deletion", out.c_str());
        return;
      }

      // Check if enrollment is active
      if (fingerprintEnrollmentActive) {
        Serial.println("[FINGERPRINT DELETE] Cannot delete during enrollment");
        StaticJsonDocument<128> doc;
        doc["status"] = "failed";
        doc["fingerprintId"] = fpId;
        doc["error"] = "Cannot delete fingerprint while enrollment is active";
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/status/fingerprint/deletion", out.c_str());
        return;
      }

      Serial.print("[FINGERPRINT DELETE] Deleting fingerprint ID: ");
      Serial.println(fpId);

      // Delete fingerprint from AS608 sensor
      uint8_t result = finger.deleteModel(fpId);

      if (result == FINGERPRINT_OK) {
        Serial.println("[FINGERPRINT DELETE] Success");

        StaticJsonDocument<64> doc;
        doc["status"] = "success";
        doc["fingerprintId"] = fpId;
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/status/fingerprint/deletion", out.c_str());

      } else {
        Serial.print("[FINGERPRINT DELETE] Failed with error code: ");
        Serial.println(result);

        StaticJsonDocument<128> doc;
        doc["status"] = "failed";
        doc["fingerprintId"] = fpId;

        // Provide error details based on AS608 error code
        if (result == FINGERPRINT_PACKETRECIEVEERR) {
          doc["error"] = "Communication error with sensor";
        } else if (result == FINGERPRINT_DELETEFAIL) {
          doc["error"] = "Failed to delete from sensor";
        } else {
          doc["error"] = "Sensor error";
        }

        String out;
        serializeJson(doc, out);
        mqtt.publish("home/status/fingerprint/deletion", out.c_str());
      }
    }
  }
}

// ===== Publish Functions =====
void publishStatusDoor() {
  StaticJsonDocument<128> doc;
  doc["locked"] = doorLocked;
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/door", out.c_str(), true);
}

void publishStatusLiving() {
  StaticJsonDocument<128> doc;
  doc["led"] = livingLED;
  doc["exhaustFan"] = livingFan;
  doc["ac"] = livingAC;
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/living", out.c_str(), true);
}

void publishStatusKitchen() {
  StaticJsonDocument<128> doc;
  doc["led"] = kitchenLED;
  doc["exhaustFan"] = kitchenFan;
  doc["window"] = kitchenWindow;
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/kitchen", out.c_str(), true);
}

void publishStatusBedroom() {
  StaticJsonDocument<128> doc;
  doc["led"] = bedroomLED;
  doc["fan"] = bedroomFan;
  doc["ac"] = bedroomAC;
  doc["window"] = bedroomWindow;
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/bedroom", out.c_str(), true);
}

/*
 * โหมดที่ทำงานอยู่จริงบนบอร์ด - retain ไว้ให้ backend/dashboard
 * ที่ต่อเข้ามาใหม่รู้สถานะทันทีโดยไม่ต้องถาม
 */
void publishStatusMode() {
  StaticJsonDocument<64> doc;
  doc["mode"] = (currentMode == MODE_AUTOMATIC) ? "on" : "off";
  String out;
  serializeJson(doc, out);
  bool sent = mqtt.publish("home/status/mode", out.c_str(), true);
  Serial.print("[AUTO DEBUG] Published home/status/mode -> ");
  Serial.print(out);
  Serial.print(" (publish() returned ");
  Serial.print(sent ? "true" : "false - check mqtt.setBufferSize / connection");
  Serial.println(")");
}

/*
 * ค่า timeout ปัจจุบันบนบอร์ด (source of truth) - หน่วยวินาทีตอน publish
 * เก็บ internal เป็น ms เหมือนเดิม แปลงเฉพาะตอนส่งออก/รับเข้า
 * retain ไว้เหมือน home/status/mode ให้ dashboard ที่ต่อเข้ามาใหม่รู้ค่าจริงทันที
 */
void publishStatusAutoSettings() {
  StaticJsonDocument<64> doc;
  doc["lightFanTimeout"] = autoLightFanTimeout / 1000;
  doc["acTimeout"] = autoACTimeout / 1000;
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/auto/settings", out.c_str(), true);
  Serial.print("[AUTO SETTINGS] Published -> ");
  Serial.println(out);
}

/*
 * สถานะ PIR จริงแบบ real-time สำหรับ dashboard - อ่าน GPIO ตรงๆ
 * (ROOM_PIR_PINS เดิม) ไม่เกี่ยวกับ lastMotion/automation ใดๆ ทั้งสิ้น
 * publish เฉพาะตอนมีค่าเปลี่ยน หรือครั้งแรกหลัง MQTT connect เพื่อไม่ spam
 * retain ไว้เหมือน topic status อื่นๆ ให้ dashboard ที่ต่อใหม่รู้ค่าทันที
 */
void checkAndPublishPIRStatus() {
  bool living  = digitalRead(PIN_PIR_LIVING)  == HIGH;
  bool kitchen = digitalRead(PIN_PIR_KITCHEN) == HIGH;
  bool bedroom = digitalRead(PIN_PIR_BEDROOM) == HIGH;

  bool changed = !pirStatusInitialized ||
                 living  != prevPirLiving  ||
                 kitchen != prevPirKitchen ||
                 bedroom != prevPirBedroom;

  if (!changed) return;

  prevPirLiving  = living;
  prevPirKitchen = kitchen;
  prevPirBedroom = bedroom;
  pirStatusInitialized = true;

  StaticJsonDocument<96> doc;
  doc["living"]  = living;
  doc["kitchen"] = kitchen;
  doc["bedroom"] = bedroom;
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/pir", out.c_str(), true);
}

/*
 * ส่ง debug log ของ Automatic Mode ออกไปทาง MQTT (home/debug/log)
 * เพื่อให้ดูผ่าน Web Dashboard ได้โดยไม่ต้องต่อ USB Serial Monitor
 *
 * Telemetry เสริมเท่านั้น - ไม่ block loop, ไม่ delay, และถ้า publish
 * ไม่สำเร็จ (หลุด MQTT ก็ตาม) ตัวแปรค่า/logic ของ Automatic Mode จริง
 * ไม่ได้อิงจากผลลัพธ์การ publish นี้เลย - เขียนแค่ Serial เป็น fallback
 */
void publishDebugLog(String message) {
  Serial.println(message);

  if (!mqtt.connected()) return;

  StaticJsonDocument<256> doc;
  doc["message"] = message;
  doc["timestamp"] = millis();

  String out;
  serializeJson(doc, out);
  mqtt.publish("home/debug/log", out.c_str());
}

void publishSensors() {
  // DHT22
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();
  if (!isnan(temp) && !isnan(hum)) {
    StaticJsonDocument<64> doc;
    doc["temp"] = round(temp * 10) / 10.0;
    doc["hum"] = round(hum * 10) / 10.0;
    String out;
    serializeJson(doc, out);
    mqtt.publish("home/sensor/dht22", out.c_str(), true);
  }

  // PIR sensors
  {
    StaticJsonDocument<32> doc;
    doc["pir"] = digitalRead(PIN_PIR_LIVING);
    String out;
    serializeJson(doc, out);
    mqtt.publish("home/sensor/pir/living", out.c_str(), false);
  }
  {
    StaticJsonDocument<32> doc;
    doc["pir"] = digitalRead(PIN_PIR_KITCHEN);
    String out;
    serializeJson(doc, out);
    mqtt.publish("home/sensor/pir/kitchen", out.c_str(), false);
  }
  {
    StaticJsonDocument<32> doc;
    doc["pir"] = digitalRead(PIN_PIR_BEDROOM);
    String out;
    serializeJson(doc, out);
    mqtt.publish("home/sensor/pir/bedroom", out.c_str(), false);
  }
}

void reconnectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Connecting to ");
    Serial.print(MQTT_SERVER);
    Serial.print("...");

    String clientId = "esp32_smarthome_" + String(random(0xffff), HEX);

    if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
      Serial.println(" OK");

      // Subscribe to all control topics - พิมพ์ผลลัพธ์ทุก topic ทุกครั้งที่ต่อใหม่
      // เพื่อยืนยันว่า subscribe ผ่านจริง ไม่ใช่แค่ connect ผ่าน
      const char* controlTopics[] = {
        "home/control/door",
        "home/control/living/led",
        "home/control/living/fan",
        "home/control/living/ac",
        "home/control/kitchen/led",
        "home/control/kitchen/fan",
        "home/control/kitchen/window",
        "home/control/bedroom/led",
        "home/control/bedroom/fan",
        "home/control/bedroom/ac",
        "home/control/bedroom/window",
        "home/control/auto",
        "home/control/auto/settings",
        "home/control/fingerprint/enroll",
        "home/control/fingerprint/delete"
      };
      const int controlTopicCount = sizeof(controlTopics) / sizeof(controlTopics[0]);
      for (int i = 0; i < controlTopicCount; i++) {
        bool result = mqtt.subscribe(controlTopics[i]);
        Serial.print("[MQTT SUBSCRIBE] ");
        Serial.print(controlTopics[i]);
        Serial.print(" = ");
        Serial.println(result ? "SUCCESS" : "FAILED");
      }

      // Publish initial status
      publishStatusDoor();
      publishStatusLiving();
      publishStatusKitchen();
      publishStatusBedroom();
      publishStatusMode();
      publishStatusAutoSettings();
      pirStatusInitialized = false;  // force PIR publish once on (re)connect
      checkAndPublishPIRStatus();
    } else {
      Serial.print(" FAILED, rc=");
      Serial.println(mqtt.state());
      delay(5000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n\n=== Smart Home IoT System ===");
  Serial.println("Initializing...");

  // Initialize all relay pins to OFF (HIGH = OFF for Active LOW)
  pinMode(PIN_DOOR_LOCK, OUTPUT);
  pinMode(PIN_LIVING_LED, OUTPUT);
  pinMode(PIN_LIVING_FAN, OUTPUT);
  pinMode(PIN_KITCHEN_LED, OUTPUT);
  pinMode(PIN_KITCHEN_FAN, OUTPUT);
  pinMode(PIN_BEDROOM_LED, OUTPUT);
  pinMode(PIN_BEDROOM_FAN, OUTPUT);

  digitalWrite(PIN_DOOR_LOCK, HIGH);      // Door locked
  digitalWrite(PIN_LIVING_LED, HIGH);     // All OFF
  digitalWrite(PIN_LIVING_FAN, HIGH);
  digitalWrite(PIN_KITCHEN_LED, HIGH);
  digitalWrite(PIN_KITCHEN_FAN, HIGH);
  digitalWrite(PIN_BEDROOM_LED, HIGH);
  digitalWrite(PIN_BEDROOM_FAN, HIGH);

  Serial.println("[GPIO] Relays initialized (all OFF)");

  // Initialize PWM for AC control BEFORE servos to claim high channels
  ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);
  ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);
  ledcAttachPin(PIN_LIVING_AC, PWM_CHANNEL_LIVING);
  ledcAttachPin(PIN_BEDROOM_AC, PWM_CHANNEL_BEDROOM);
  ledcWrite(PWM_CHANNEL_LIVING, 0);
  ledcWrite(PWM_CHANNEL_BEDROOM, 0);

  Serial.println("[GPIO] PWM initialized (channels 12, 13)");

  // Initialize servos AFTER PWM to allow ESP32Servo to use low channels
  // Kitchen Window Servo is NOT attached during startup.
  // It will attach only after an explicit MQTT command.
  servoBedroomWindow.attach(PIN_BEDROOM_WINDOW, 500, 2400);

  Serial.println("[GPIO] Servos initialized");

  // Initialize PIR sensors (input only pins)
  pinMode(PIN_PIR_LIVING, INPUT);
  pinMode(PIN_PIR_BEDROOM, INPUT);
  pinMode(PIN_PIR_KITCHEN, INPUT);

  Serial.println("[GPIO] PIR sensors initialized");

  // Initialize automatic mode state (เริ่มที่ Manual ตามสเปก)
  for (int i = 0; i < ROOM_COUNT; i++) {
    roomAuto[i].lastMotion = millis();
    roomAuto[i].lightFanTimerFired = false;
    roomAuto[i].acTimerFired = false;
    roomAuto[i].ledShutdown = false;
    roomAuto[i].fanShutdown = false;
    roomAuto[i].acShutdown = false;
    roomAuto[i].lastPirState = false;
    // relay ทั้งหมดเริ่มที่ OFF จึงตั้ง user state ให้ตรงกับของจริง
    roomAuto[i].userLED = false;
    roomAuto[i].userFan = false;
    roomAuto[i].userAC = 0;
  }

  Serial.println("[MODE] Manual mode (default)");

  // Initialize DHT22
  dht.begin();
  Serial.println("[GPIO] DHT22 initialized");

  // Initialize AS608 Fingerprint Sensor
  Serial2.begin(57600, SERIAL_8N1, PIN_AS608_RX, PIN_AS608_TX);
  finger.begin(57600);
  delay(100);

  if (finger.verifyPassword()) {
    Serial.println("[AS608] Fingerprint sensor detected!");
  } else {
    Serial.println("[AS608] ERROR: Fingerprint sensor NOT detected!");
  }

  // Connect to WiFi
  Serial.print("[WiFi] Connecting to ");
  Serial.print(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" OK");
    Serial.print("[WiFi] IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" FAILED");
    Serial.print("[WiFi] Status: ");
    Serial.println(WiFi.status());
    Serial.println("[WiFi] Continuing without WiFi...");
  }

  // Configure MQTT with TLS
  wifiClient.setInsecure();  // Skip certificate verification for now
  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setKeepAlive(60);
  mqtt.setBufferSize(512);

  Serial.println("[MQTT] Client configured");
  Serial.println("=== Initialization Complete ===\n");
}

void loop() {
  // Reconnect MQTT if needed
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected()) {
    reconnectMQTT();
  }

  mqtt.loop();

  unsigned long now = millis();

  // Automatic mode - อ่าน PIR แล้วปิด/คืนค่าอุปกรณ์ตาม inactivity
  // เรียกทุก loop ไม่มีเงื่อนไขขั้น ตัวฟังก์ชันเช็ค currentMode เองด้านใน
  if (currentMode == MODE_AUTOMATIC) {
    updateAutomaticMode();
  }

  // PIR status broadcast (แยกจาก automation ด้านบนโดยสิ้นเชิง) - เช็คทุก loop
  // แต่ publish เฉพาะตอนเปลี่ยนค่าจริงเท่านั้น (ดูใน checkAndPublishPIRStatus)
  if (mqtt.connected()) {
    checkAndPublishPIRStatus();
  }

  // Publish sensors periodically
  if (now - lastSensor >= SENSOR_INTERVAL) {
    lastSensor = now;
    if (mqtt.connected()) {
      publishSensors();
    }
  }

  // Publish status periodically
  if (now - lastStatus >= STATUS_INTERVAL) {
    lastStatus = now;
    if (mqtt.connected()) {
      publishStatusDoor();
      publishStatusLiving();
      publishStatusKitchen();
      publishStatusBedroom();
      publishStatusMode();
    }
  }

  // Check fingerprint sensor
  if (fingerprintEnrollmentActive) {
    processEnrollment();
  } else {
    checkFingerprint();
  }
}

/* =======================================
   FINGERPRINT FUNCTIONS
======================================= */

void checkFingerprint() {
  uint8_t result = finger.getImage();

  // No finger detected - reset state and return
  if (result == FINGERPRINT_NOFINGER) {
    if (fingerDetected) {
      // Finger was just removed
      fingerDetected = false;
      fingerprintProcessing = false;
      Serial.println("[FINGERPRINT] Ready for next scan");
    }
    return;
  }

  // Finger detected for the first time
  if (result == FINGERPRINT_OK && !fingerDetected && !fingerprintProcessing) {
    fingerDetected = true;
    fingerprintProcessing = true;
    Serial.println("[FINGERPRINT] Finger detected");

    // Convert image to template
    result = finger.image2Tz();
    if (result != FINGERPRINT_OK) {
      Serial.println("[FINGERPRINT] IMAGE CONVERSION FAILED");
      fingerprintProcessing = false;
      return;
    }

    // Search for fingerprint match
    result = finger.fingerFastSearch();
    if (result == FINGERPRINT_OK) {
      // Match found
      Serial.println("[FINGERPRINT] MATCH FOUND");
      Serial.print("[FINGERPRINT] ID: ");
      Serial.println(finger.fingerID);
      Serial.print("[FINGERPRINT] Confidence: ");
      Serial.println(finger.confidence);

      // Publish MQTT event
      if (mqtt.connected()) {
        StaticJsonDocument<96> doc;
        doc["status"] = "success";
        doc["fingerprintId"] = finger.fingerID;
        doc["confidence"] = finger.confidence;
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/sensor/fingerprint", out.c_str(), false);
        Serial.println("[FINGERPRINT MQTT] Published successfully");
        Serial.print("[FINGERPRINT MQTT] ID: ");
        Serial.println(finger.fingerID);
        Serial.print("[FINGERPRINT MQTT] Confidence: ");
        Serial.println(finger.confidence);
      }
    } else if (result == FINGERPRINT_NOTFOUND) {
      // No match
      Serial.println("[FINGERPRINT] NO MATCH FOUND");

      // Publish MQTT event
      if (mqtt.connected()) {
        StaticJsonDocument<32> doc;
        doc["status"] = "failed";
        String out;
        serializeJson(doc, out);
        mqtt.publish("home/sensor/fingerprint", out.c_str(), false);
        Serial.println("[FINGERPRINT MQTT] Published failed");
      }
    } else {
      // Other error
      Serial.println("[FINGERPRINT] SEARCH ERROR");
    }

    fingerprintProcessing = false;
  }
}

/* =======================================
   FINGERPRINT ENROLLMENT STATE MACHINE
======================================= */

void processEnrollment() {
  // Timeout check - 120 seconds
  if (millis() - enrollmentStateStartTime > 120000) {
    Serial.println("[FINGERPRINT ENROLL] Timeout");
    publishEnrollmentStatus("failed", "Enrollment timeout");
    fingerprintEnrollmentActive = false;
    fingerprintEnrollState = FP_ENROLL_IDLE;
    return;
  }

  uint8_t result;

  switch (fingerprintEnrollState) {
    case FP_ENROLL_IDLE:
      // Should not reach here
      break;

    case FP_ENROLL_WAIT_FIRST_FINGER:
      Serial.println("[FINGERPRINT ENROLL] Waiting for first finger placement");
      publishEnrollmentStatus("place_finger_1", "");
      fingerprintEnrollState = FP_ENROLL_CAPTURE_FIRST;
      enrollmentStateStartTime = millis();
      break;

    case FP_ENROLL_CAPTURE_FIRST:
      result = finger.getImage();
      if (result == FINGERPRINT_OK) {
        Serial.println("[FINGERPRINT ENROLL] First image captured");
        result = finger.image2Tz(1);

        if (result == FINGERPRINT_OK) {
          Serial.println("[FINGERPRINT ENROLL] First template created");
          publishEnrollmentStatus("first_scan_success", "");
          fingerprintEnrollState = FP_ENROLL_WAIT_REMOVE_FIRST;
          enrollmentStateStartTime = millis();
        } else {
          Serial.println("[FINGERPRINT ENROLL] First template conversion failed");
          publishEnrollmentStatus("failed", "Image conversion failed");
          fingerprintEnrollmentActive = false;
          fingerprintEnrollState = FP_ENROLL_IDLE;
        }
      } else if (result == FINGERPRINT_NOFINGER) {
        // Still waiting
      } else {
        Serial.println("[FINGERPRINT ENROLL] First image capture failed");
        publishEnrollmentStatus("failed", "Image capture failed");
        fingerprintEnrollmentActive = false;
        fingerprintEnrollState = FP_ENROLL_IDLE;
      }
      break;

    case FP_ENROLL_WAIT_REMOVE_FIRST:
      result = finger.getImage();
      if (result == FINGERPRINT_NOFINGER) {
        Serial.println("[FINGERPRINT ENROLL] Finger removed");
        publishEnrollmentStatus("remove_finger", "");
        fingerprintEnrollState = FP_ENROLL_WAIT_SECOND_FINGER;
        enrollmentStateStartTime = millis();
      }
      break;

    case FP_ENROLL_WAIT_SECOND_FINGER:
      Serial.println("[FINGERPRINT ENROLL] Waiting for second finger placement");
      publishEnrollmentStatus("place_finger_2", "");
      fingerprintEnrollState = FP_ENROLL_CAPTURE_SECOND;
      enrollmentStateStartTime = millis();
      break;

    case FP_ENROLL_CAPTURE_SECOND:
      result = finger.getImage();
      if (result == FINGERPRINT_OK) {
        Serial.println("[FINGERPRINT ENROLL] Second image captured");
        result = finger.image2Tz(2);

        if (result == FINGERPRINT_OK) {
          Serial.println("[FINGERPRINT ENROLL] Second template created");
          publishEnrollmentStatus("second_scan_success", "");
          fingerprintEnrollState = FP_ENROLL_CREATE_MODEL;
          enrollmentStateStartTime = millis();
        } else {
          Serial.println("[FINGERPRINT ENROLL] Second template conversion failed");
          publishEnrollmentStatus("failed", "Image conversion failed");
          fingerprintEnrollmentActive = false;
          fingerprintEnrollState = FP_ENROLL_IDLE;
        }
      } else if (result == FINGERPRINT_NOFINGER) {
        // Still waiting
      } else {
        Serial.println("[FINGERPRINT ENROLL] Second image capture failed");
        publishEnrollmentStatus("failed", "Image capture failed");
        fingerprintEnrollmentActive = false;
        fingerprintEnrollState = FP_ENROLL_IDLE;
      }
      break;

    case FP_ENROLL_CREATE_MODEL:
      Serial.println("[FINGERPRINT ENROLL] Creating model");
      result = finger.createModel();

      if (result == FINGERPRINT_OK) {
        Serial.println("[FINGERPRINT ENROLL] Model created successfully");
        fingerprintEnrollState = FP_ENROLL_STORE_MODEL;
      } else if (result == FINGERPRINT_ENROLLMISMATCH) {
        Serial.println("[FINGERPRINT ENROLL] Fingerprints do not match");
        publishEnrollmentStatus("failed", "Fingerprint scans do not match");
        fingerprintEnrollmentActive = false;
        fingerprintEnrollState = FP_ENROLL_IDLE;
      } else {
        Serial.println("[FINGERPRINT ENROLL] Model creation failed");
        publishEnrollmentStatus("failed", "Model creation failed");
        fingerprintEnrollmentActive = false;
        fingerprintEnrollState = FP_ENROLL_IDLE;
      }
      break;

    case FP_ENROLL_STORE_MODEL:
      Serial.print("[FINGERPRINT ENROLL] Storing model at ID: ");
      Serial.println(enrollingFingerprintId);

      result = finger.storeModel(enrollingFingerprintId);

      if (result == FINGERPRINT_OK) {
        Serial.println("[FINGERPRINT ENROLL] Success!");
        publishEnrollmentStatus("success", "");
        fingerprintEnrollState = FP_ENROLL_SUCCESS;
      } else {
        Serial.println("[FINGERPRINT ENROLL] Storage failed");
        publishEnrollmentStatus("failed", "Storage failed");
        fingerprintEnrollmentActive = false;
        fingerprintEnrollState = FP_ENROLL_IDLE;
      }
      break;

    case FP_ENROLL_SUCCESS:
      fingerprintEnrollmentActive = false;
      fingerprintEnrollState = FP_ENROLL_IDLE;
      enrollingFingerprintId = 0;
      break;

    case FP_ENROLL_FAILED:
      fingerprintEnrollmentActive = false;
      fingerprintEnrollState = FP_ENROLL_IDLE;
      enrollingFingerprintId = 0;
      break;
  }
}

void publishEnrollmentStatus(const char* status, const char* error) {
  if (!mqtt.connected()) return;

  StaticJsonDocument<128> doc;
  doc["status"] = status;
  doc["fingerprintId"] = enrollingFingerprintId;

  if (error && strlen(error) > 0) {
    doc["error"] = error;
  }

  String out;
  serializeJson(doc, out);
  mqtt.publish("home/status/fingerprint/enrollment", out.c_str());

  Serial.print("[FINGERPRINT ENROLL] Status published: ");
  Serial.println(out);
}
