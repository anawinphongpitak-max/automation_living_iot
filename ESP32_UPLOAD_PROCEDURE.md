# ESP32 FIRMWARE UPLOAD PROCEDURE

**Date**: 2026-09-01  
**Firmware File**: `esp32/smart_home/smart_home.ino`  
**Status**: ✅ READY FOR PHYSICAL UPLOAD

---

## FINAL STATIC VERIFICATION COMPLETE ✅

### 1. GPIO Mapping - VERIFIED ✅

| GPIO | Function | Type | Notes |
|------|----------|------|-------|
| 4 | Bedroom Curtain | 360° Servo | Continuous rotation |
| 5 | Living AC | PWM (JZ-MOS1) | 70%, 90%, 100% |
| 13 | Door Lock | Relay IN1 | **Active LOW** |
| 14 | Living LED | Relay IN2 | **Active LOW** |
| 16 | AS608 RX | UART2 | Placeholder only |
| 17 | AS608 TX | UART2 | Placeholder only |
| 18 | Bedroom Fan | Relay IN7 | **Active LOW** |
| 19 | DHT22 Data | Sensor Input | Temperature/Humidity |
| 21 | Bedroom AC | PWM (JZ-MOS2) | 70%, 90%, 100% |
| 22 | Kitchen Window | 180° Servo | Positional |
| 23 | Kitchen Curtain | 360° Servo | Continuous rotation |
| 25 | Living Fan | Relay IN5 | **Active LOW** |
| 26 | Bedroom LED | Relay IN4 | **Active LOW** |
| 27 | Kitchen LED | Relay IN3 | **Active LOW** |
| 32 | Bedroom Window | 180° Servo | Positional |
| 33 | Kitchen Fan | Relay IN6 | **Active LOW** |
| 34 | PIR Living | Digital Input | **Input only** |
| 35 | PIR Bedroom | Digital Input | **Input only** |
| 36 | PIR Kitchen | Digital Input | **Input only** |

**Total**: 19 GPIO pins configured

---

### 2. Active LOW Relay Logic - VERIFIED ✅

**Implementation**:
```cpp
void setRelay(int pin, bool on) {
  digitalWrite(pin, on ? LOW : HIGH);  // Active LOW
}
```

**Initialization (Safety)**:
```cpp
digitalWrite(PIN_DOOR_LOCK, HIGH);      // Relay OFF (door locked)
digitalWrite(PIN_LIVING_LED, HIGH);     // Relay OFF
digitalWrite(PIN_LIVING_FAN, HIGH);     // Relay OFF
digitalWrite(PIN_KITCHEN_LED, HIGH);    // Relay OFF
digitalWrite(PIN_KITCHEN_FAN, HIGH);    // Relay OFF
digitalWrite(PIN_BEDROOM_LED, HIGH);    // Relay OFF
digitalWrite(PIN_BEDROOM_FAN, HIGH);    // Relay OFF
```

**Logic**:
- `HIGH` signal → Relay OFF → Device OFF (safe default)
- `LOW` signal → Relay ON → Device ON

**Door Lock Special Case**:
```cpp
setRelay(PIN_DOOR_LOCK, !doorLocked);  // Inverted: unlocked=ON=LOW
```
- When `doorLocked = true` → `!doorLocked = false` → Relay OFF (HIGH)
- When `doorLocked = false` → `!doorLocked = true` → Relay ON (LOW)

✅ **CORRECT**: All relays initialized to safe OFF state on boot

---

### 3. HiveMQ TLS Configuration - VERIFIED ✅

**MQTT Broker**:
```cpp
const char* MQTT_SERVER = "your-hivemq-cluster.hivemq.cloud";
const int   MQTT_PORT   = 8883;  // TLS port
const char* MQTT_USER   = "your-mqtt-username";
const char* MQTT_PASS   = "your-mqtt-password";
```

**TLS Setup**:
```cpp
WiFiClientSecure wifiClient;
wifiClient.setInsecure();  // Skip certificate verification (development)
mqtt.setServer(MQTT_SERVER, MQTT_PORT);
```

✅ **CORRECT**: Port 8883 (MQTT over TLS), matches backend configuration

---

### 4. WiFi Configuration - VERIFIED ✅

**WiFi Credentials**:
```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
```

**Connection Logic**:
```cpp
WiFi.begin(WIFI_SSID, WIFI_PASS);
int attempts = 0;
while (WiFi.status() != WL_CONNECTED && attempts < 20) {
  delay(500);
  Serial.print(".");
  attempts++;
}
```

✅ **CORRECT**: 10-second timeout (20 × 500ms), continues without WiFi if failed

---

### 5. MQTT Topics - VERIFIED ✅

**Subscribed Topics (Commands from Backend)**:
```cpp
mqtt.subscribe("home/control/door");
mqtt.subscribe("home/control/living/led");
mqtt.subscribe("home/control/living/fan");
mqtt.subscribe("home/control/living/ac");
mqtt.subscribe("home/control/kitchen/led");
mqtt.subscribe("home/control/kitchen/fan");
mqtt.subscribe("home/control/kitchen/window");
mqtt.subscribe("home/control/kitchen/curtain");
mqtt.subscribe("home/control/bedroom/led");
mqtt.subscribe("home/control/bedroom/fan");
mqtt.subscribe("home/control/bedroom/ac");
mqtt.subscribe("home/control/bedroom/window");
mqtt.subscribe("home/control/bedroom/curtain");
```
**Total**: 13 control topics

**Published Topics (Status/Sensors to Backend)**:
```cpp
mqtt.publish("home/status/door", ...);
mqtt.publish("home/status/living", ...);
mqtt.publish("home/status/kitchen", ...);
mqtt.publish("home/status/bedroom", ...);
mqtt.publish("home/sensor/dht22", ...);
mqtt.publish("home/sensor/pir/living", ...);
mqtt.publish("home/sensor/pir/kitchen", ...);
mqtt.publish("home/sensor/pir/bedroom", ...);
```
**Total**: 8 status/sensor topics

✅ **CORRECT**: All topics match backend specification exactly

---

### 6. Servo Configuration - VERIFIED ✅

**180° Servos (Positional)**:
```cpp
servoKitchenWindow.attach(PIN_KITCHEN_WINDOW, 500, 2400);
servoBedroomWindow.attach(PIN_BEDROOM_WINDOW, 500, 2400);
servoKitchenWindow.write(0);    // Start at 0°
servoBedroomWindow.write(0);    // Start at 0°
```
- Pulse width: 500-2400 μs (standard servo range)
- Control: Direct angle (0-180 degrees)

**360° Servos (Continuous Rotation)**:
```cpp
servoKitchenCurtain.attach(PIN_KITCHEN_CURTAIN, 500, 2400);
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);
servoKitchenCurtain.write(90);  // Stop
servoBedroomCurtain.write(90);  // Stop

void set360Servo(Servo &servo, String action) {
  if (action == "open")       servo.write(180);  // CW full speed
  else if (action == "close") servo.write(0);    // CCW full speed
  else                        servo.write(90);   // Stop
}
```

✅ **CORRECT**: Both servo types configured correctly, safe initialization (stopped)

---

### 7. AC PWM Levels - VERIFIED ✅

**PWM Configuration**:
```cpp
#define PWM_FREQ            1000      // 1 kHz
#define PWM_RESOLUTION      8         // 8-bit (0-255)
#define PWM_CHANNEL_LIVING  0
#define PWM_CHANNEL_BEDROOM 1
```

**Level Mapping**:
```cpp
void setAC(int channel, int level) {
  int duty = 0;
  if (level == 70)       duty = 179;  // ~70% of 255
  else if (level == 90)  duty = 230;  // ~90% of 255
  else if (level == 100) duty = 255;  // 100%
  ledcWrite(channel, duty);
}
```

**Verification**:
- 70% → 179/255 = 70.2% ✓
- 90% → 230/255 = 90.2% ✓
- 100% → 255/255 = 100% ✓
- OFF → 0/255 = 0% ✓

✅ **CORRECT**: PWM duty cycles match specification

---

### 8. DHT22 Sensor - VERIFIED ✅

**Configuration**:
```cpp
#define PIN_DHT22           19
#define DHT_TYPE            DHT22
DHT dht(PIN_DHT22, DHT_TYPE);

void setup() {
  dht.begin();
  Serial.println("[GPIO] DHT22 initialized");
}
```

**Reading**:
```cpp
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
```

**Publishing Interval**: Every 2 seconds

✅ **CORRECT**: DHT22 on GPIO 19, proper error handling (NaN check)

---

### 9. PIR Sensors - VERIFIED ✅

**Configuration**:
```cpp
#define PIN_PIR_LIVING      34  // Input only
#define PIN_PIR_BEDROOM     35  // Input only
#define PIN_PIR_KITCHEN     36  // Input only

void setup() {
  pinMode(PIN_PIR_LIVING, INPUT);
  pinMode(PIN_PIR_BEDROOM, INPUT);
  pinMode(PIN_PIR_KITCHEN, INPUT);
  Serial.println("[GPIO] PIR sensors initialized");
}
```

**Reading**:
```cpp
// Living PIR
{
  StaticJsonDocument<32> doc;
  doc["pir"] = digitalRead(PIN_PIR_LIVING);
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/sensor/pir/living", out.c_str(), false);
}
// Kitchen PIR
{
  StaticJsonDocument<32> doc;
  doc["pir"] = digitalRead(PIN_PIR_KITCHEN);
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/sensor/pir/kitchen", out.c_str(), false);
}
// Bedroom PIR
{
  StaticJsonDocument<32> doc;
  doc["pir"] = digitalRead(PIN_PIR_BEDROOM);
  String out;
  serializeJson(doc, out);
  mqtt.publish("home/sensor/pir/bedroom", out.c_str(), false);
}
```

**Publishing Interval**: Every 2 seconds

✅ **CORRECT**: GPIO 34, 35, 36 are input-only pins, configured as INPUT

---

### 10. AS608 UART - VERIFIED ✅

**Configuration**:
```cpp
#define PIN_AS608_RX        16
#define PIN_AS608_TX        17

void setup() {
  // Serial2.begin(57600, SERIAL_8N1, PIN_AS608_RX, PIN_AS608_TX);
  Serial.println("[GPIO] AS608 UART ready (not implemented yet)");
}
```

✅ **CORRECT**: Pins reserved, UART commented out (placeholder for future implementation)

---

## ARDUINO IDE UPLOAD PROCEDURE

### STEP 1: Install Required Libraries

Open Arduino IDE → **Sketch** → **Include Library** → **Manage Libraries**

Install the following libraries:

| Library Name | Author | Version | Notes |
|--------------|--------|---------|-------|
| **PubSubClient** | Nick O'Leary | 2.8+ | MQTT client |
| **ArduinoJson** | Benoit Blanchon | 6.21.0+ | JSON parsing |
| **DHT sensor library** | Adafruit | 1.4.0+ | DHT22 sensor |
| **Adafruit Unified Sensor** | Adafruit | Auto-installed | Dependency |
| **ESP32Servo** | Kevin Harrington | 0.13.0+ | Servo control |

**Installation Steps**:
1. Click "Library Manager" button (book icon in toolbar)
2. Search for each library name
3. Click "Install" for each library
4. Accept dependency installations when prompted

---

### STEP 2: Configure Board Settings

**Tools** → **Board** → **ESP32 Arduino** → **ESP32 Dev Module**

Then configure these settings:

| Setting | Value | Location |
|---------|-------|----------|
| **Board** | ESP32 Dev Module | Tools → Board |
| **Upload Speed** | 115200 | Tools → Upload Speed |
| **CPU Frequency** | 240MHz (WiFi/BT) | Tools → CPU Frequency |
| **Flash Frequency** | 80MHz | Tools → Flash Frequency |
| **Flash Mode** | QIO | Tools → Flash Mode |
| **Flash Size** | 4MB (32Mb) | Tools → Flash Size |
| **Partition Scheme** | Default 4MB with spiffs | Tools → Partition Scheme |
| **Core Debug Level** | None | Tools → Core Debug Level |
| **PSRAM** | Disabled | Tools → PSRAM |

---

### STEP 3: Select Serial Port

**Tools** → **Port** → Select your ESP32 COM port

- **Windows**: Usually COM3, COM4, COM5, etc.
- **Mac/Linux**: Usually /dev/ttyUSB0 or /dev/cu.usbserial-*

**If port not visible**:
1. Connect ESP32 via USB cable
2. Install CP2102 or CH340 USB driver if needed
3. Restart Arduino IDE
4. Check Device Manager (Windows) for COM port number

---

### STEP 4: Open Firmware File

**File** → **Open** → Navigate to:

```
D:\Downloads\files\automation_living_iot_v2\esp32\smart_home\smart_home.ino
```

Verify the file opens and shows the complete firmware code.

---

### STEP 5: Verify WiFi Credentials

Before uploading, confirm these lines match your WiFi network:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
```

**If different**, edit these lines to match your actual WiFi network name and password.

---

### STEP 6: Compile (Verify)

Click the **Verify** button (✓ checkmark icon) or press **Ctrl+R**

**Expected Output**:
```
Sketch uses XXXXX bytes (XX%) of program storage space. Maximum is 1310720 bytes.
Global variables use XXXXX bytes (XX%) of dynamic memory, leaving XXXXX bytes for local variables. Maximum is 327680 bytes.
```

**Success Criteria**:
- ✅ "Done compiling" message appears
- ✅ Program storage < 80% (should be ~35-45%)
- ✅ Dynamic memory < 70% (should be ~15-25%)
- ✅ No error messages in red

**If compilation fails**:
1. Check all libraries are installed
2. Verify board is "ESP32 Dev Module"
3. Read error messages carefully
4. Report exact error message for troubleshooting

---

### STEP 7: Upload Firmware

Click the **Upload** button (→ arrow icon) or press **Ctrl+U**

**During Upload**:
1. Arduino IDE compiles the code
2. Shows "Connecting..." message
3. May show dots (........____....) indicating upload progress
4. ESP32 should be in bootloader mode (automatic on most boards)

**If upload fails with "Connecting..." timeout**:
1. Hold the **BOOT** button on ESP32
2. Press and release the **EN** (ENABLE/RESET) button while holding BOOT
3. Release BOOT button
4. Click Upload again immediately

**Expected Output**:
```
Writing at 0x00001000... (X%)
...
Writing at 0x000XXXXX... (100%)
Wrote XXXXXX bytes (XXXXXX compressed) at 0x00001000 in X.X seconds (effective XXX.X kbit/s)...
Hash of data verified.

Leaving...
Hard resetting via RTS pin...
```

**Success Criteria**:
- ✅ "Done uploading" message appears
- ✅ No error messages
- ✅ ESP32 resets automatically

---

### STEP 8: Open Serial Monitor

Click **Serial Monitor** button (magnifying glass icon) or press **Ctrl+Shift+M**

**Configure Serial Monitor**:
- **Baud Rate**: 115200 (bottom-right dropdown)
- **Line Ending**: Both NL & CR (optional, bottom-left dropdown)

---

### STEP 9: Monitor Boot Sequence

After opening Serial Monitor, press the **EN** (RESET) button on ESP32 to restart.

**Expected Serial Output**:
```
=== Smart Home IoT System ===
Initializing...
[GPIO] Relays initialized (all OFF)
[GPIO] PWM initialized
[GPIO] Servos initialized
[GPIO] PIR sensors initialized
[GPIO] DHT22 initialized
[GPIO] AS608 UART ready (not implemented yet)
[WiFi] Connecting to ROV...........
[WiFi] OK
[WiFi] IP: 192.168.X.XXX
[MQTT] Client configured
=== Initialization Complete ===

[MQTT] Connecting to your-hivemq-cluster.hivemq.cloud... OK
```

---

### STEP 10: Verify Hardware Validation Checklist

✅ **WiFi Connection Successful**
- Serial Monitor shows: `[WiFi] OK`
- Serial Monitor shows: `[WiFi] IP: X.X.X.X`

✅ **MQTT Connection Successful**
- Serial Monitor shows: `[MQTT] Connecting to ...hivemq.cloud... OK`

✅ **GPIO Initialization Complete**
- Serial Monitor shows all initialization messages
- No error messages

✅ **System Ready for Testing**
- All initialization steps completed
- No crashes or resets
- Serial Monitor shows periodic status updates

---

## HARDWARE VALIDATION CRITERIA

### ⚠️ IMPORTANT: Hardware is NOT validated until:

1. ✅ Firmware uploads successfully to ESP32
2. ✅ Serial Monitor shows WiFi connection: `[WiFi] OK`
3. ✅ Serial Monitor shows MQTT connection: `[MQTT] ... OK`
4. ✅ No crashes or continuous resets
5. ✅ Backend dashboard shows "ESP32 Online ✓"
6. ✅ Commands from dashboard actually control hardware
7. ✅ Sensor data appears in dashboard (DHT22, PIR)
8. ✅ Each device tested individually and confirmed working

### Do NOT claim hardware validation is complete until:
- User confirms Serial Monitor shows successful WiFi and MQTT connection
- User tests each device from dashboard and confirms physical response
- User reports any issues with specific devices

---

## TROUBLESHOOTING

### Upload Fails - "Connecting..." Timeout
**Solution**: Hold BOOT button, press EN button, release BOOT, click Upload

### WiFi Connection Fails
**Check**:
- SSID and password are correct (case-sensitive)
- WiFi network is 2.4GHz (ESP32 does not support 5GHz)
- ESP32 is within WiFi range

### MQTT Connection Fails
**Check**:
- Internet connection is working
- HiveMQ Cloud credentials are correct
- Port 8883 is not blocked by firewall

### Continuous Resets
**Check**:
- Power supply is adequate (USB cable quality)
- No short circuits in wiring
- Serial Monitor baud rate is 115200

---

## NEXT STEPS AFTER SUCCESSFUL UPLOAD

### 1. Confirm Backend Connection
Open dashboard: http://localhost:3000
- Green dot should show "ESP32 Online ✓"

### 2. Test Each Device One by One

**Door Lock**:
- Click Lock/Unlock toggle
- Verify relay clicks (GPIO 13)
- Check Serial Monitor for `[MQTT] home/control/door -> ...`

**Living Room LED**:
- Click ON/OFF toggle
- Verify relay clicks (GPIO 14)
- Check Serial Monitor for `[MQTT] home/control/living/led -> ...`

**Continue for all 15 devices...**

### 3. Monitor for Issues
- Watch Serial Monitor for error messages
- Check for crashes or resets
- Verify sensor data appears in dashboard
- Report any device that does not respond

### 4. Report Results
After testing all devices, report:
- ✅ Which devices work correctly
- ✗ Which devices do not work
- 📝 Any error messages from Serial Monitor
- 📝 Any unexpected behavior

---

## SUMMARY

**Firmware Status**: ✅ READY FOR UPLOAD  
**Static Verification**: ✅ COMPLETE (10/10 checks passed)  
**Hardware Validation**: ⏳ PENDING (requires physical upload and testing)

**Next Action**: Upload firmware to ESP32 following the steps above, then test each device from the dashboard.

---

*Document Generated: 2026-09-01*  
*Firmware File: esp32/smart_home/smart_home.ino*  
*Expected Serial Monitor Baud: 115200*
