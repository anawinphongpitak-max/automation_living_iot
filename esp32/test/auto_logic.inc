// ===== GENERATED โดย extract_logic.js - ห้ามแก้มือ =====
// ตัดมาจาก smart_home.ino เพื่อทดสอบ logic บน PC

#define PIN_DOOR_LOCK 13
#define PIN_LIVING_LED 14
#define PIN_LIVING_FAN 25
#define PIN_KITCHEN_LED 27
#define PIN_KITCHEN_FAN 33
#define PIN_BEDROOM_LED 26
#define PIN_BEDROOM_FAN 18
#define PIN_LIVING_AC 5
#define PIN_BEDROOM_AC 21
#define PIN_PIR_LIVING 34
#define PIN_PIR_BEDROOM 35
#define PIN_PIR_KITCHEN 36
#define PWM_CHANNEL_LIVING 12
#define PWM_CHANNEL_BEDROOM 13

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


enum OperatingMode {
  MODE_MANUAL,
  MODE_AUTOMATIC
};

OperatingMode currentMode = MODE_MANUAL;

// ===== TEST MODE timers - ค่าจริงตอนส่งงานคือ 45000 / 90000 =====
const unsigned long AUTO_LIGHT_FAN_TIMEOUT = 5000;   // ไฟ + พัดลม
const unsigned long AUTO_AC_TIMEOUT        = 10000;  // แอร์จำลอง

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
  OperatingMode next = automatic ? MODE_AUTOMATIC : MODE_MANUAL;
  if (next == currentMode) {
    publishStatusMode();   // ตอบกลับเสมอ ให้ dashboard sync ได้แม้ค่าไม่เปลี่ยน
    return;
  }

  currentMode = next;
  unsigned long now = millis();

  if (currentMode == MODE_AUTOMATIC) {
    Serial.println("[MODE] Automatic enabled");

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
    Serial.print(AUTO_LIGHT_FAN_TIMEOUT / 1000);
    Serial.print("s, AC timeout ");
    Serial.print(AUTO_AC_TIMEOUT / 1000);
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
    Serial.print("[AUTO] ");
    Serial.print(ROOM_NAMES[room]);
    Serial.print(" LED -> ");
    Serial.println(r.userLED ? "ON" : "OFF");
  }

  if (r.fanShutdown) {
    applyRoomFan(room, r.userFan);
    r.fanShutdown = false;
    Serial.print("[AUTO] ");
    Serial.print(ROOM_NAMES[room]);
    Serial.print(" Fan -> ");
    Serial.println(r.userFan ? "ON" : "OFF");
  }

  if (r.acShutdown) {
    if (roomHasAC(room)) {
      applyRoomAC(room, r.userAC);
      Serial.print("[AUTO] ");
      Serial.print(ROOM_NAMES[room]);
      Serial.print(" Simulated AC -> ");
      Serial.println(r.userAC);
    }
    r.acShutdown = false;
  }

  publishRoomStatus(room);
}

void autoShutdownLightFan(RoomIndex room) {
  RoomAuto &r = roomAuto[room];
  r.lightFanTimerFired = true;
  r.ledShutdown = true;
  r.fanShutdown = true;

  Serial.print("[AUTO SHUTDOWN] ");
  Serial.print(ROOM_NAMES[room]);
  Serial.println(" LED/FAN");

  Serial.print("[AUTO] ");
  Serial.print(ROOM_NAMES[room]);
  Serial.print(" inactive for ");
  Serial.print(AUTO_LIGHT_FAN_TIMEOUT / 1000);
  Serial.println(" seconds");

  applyRoomLED(room, false);
  applyRoomFan(room, false);
  publishRoomStatus(room);
}

void autoShutdownAC(RoomIndex room) {
  RoomAuto &r = roomAuto[room];
  r.acTimerFired = true;
  r.acShutdown = true;

  Serial.print("[AUTO SHUTDOWN] ");
  Serial.print(ROOM_NAMES[room]);
  Serial.println(" AC");

  Serial.print("[AUTO] ");
  Serial.print(ROOM_NAMES[room]);
  Serial.print(" inactive for ");
  Serial.print(AUTO_AC_TIMEOUT / 1000);
  Serial.println(" seconds");

  applyRoomAC(room, 0);
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
  if (!r.lightFanTimerFired && idle >= AUTO_LIGHT_FAN_TIMEOUT) {
    autoShutdownLightFan(room);
  }

  if (!r.acTimerFired && roomHasAC(room) && idle >= AUTO_AC_TIMEOUT) {
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
    }

    if (motion) {
      // จับเฉพาะขอบขา (ไม่มีคน -> มีคน) เพื่อไม่ให้ log ท่วม
      if (!r.lastPirState) {
        Serial.print("[PIR] ");
        Serial.print(ROOM_NAMES[room]);
        Serial.println(" Motion Detected");
      }
      handleRoomMotion(room);
    } else {
      checkRoomInactivity(room, now);
    }

    r.lastPirState = motion;
  }
}




void userSetLED(RoomIndex room, bool on) {
  roomAuto[room].userLED = on;
  // ผู้ใช้สั่งเองแล้ว ยกเลิกการคืนค่าเฉพาะไฟ (พัดลม/แอร์ยังรอคืนค่าได้)
  roomAuto[room].ledShutdown = false;
  applyRoomLED(room, on);
  publishRoomStatus(room);
}

void userSetFan(RoomIndex room, bool on) {
  roomAuto[room].userFan = on;
  roomAuto[room].fanShutdown = false;
  applyRoomFan(room, on);
  publishRoomStatus(room);
}

void userSetAC(RoomIndex room, int level) {
  roomAuto[room].userAC = level;
  roomAuto[room].acShutdown = false;
  applyRoomAC(room, level);
  publishRoomStatus(room);
}



// ---------- publish stubs (แทน MQTT จริง) ----------
extern std::vector<std::string> g_published;
void publishStatusDoor()    { g_published.push_back("home/status/door"); }
void publishStatusLiving()  { g_published.push_back("home/status/living"); }
void publishStatusKitchen() { g_published.push_back("home/status/kitchen"); }
void publishStatusBedroom() { g_published.push_back("home/status/bedroom"); }
void publishStatusMode()    { g_published.push_back("home/status/mode"); }
