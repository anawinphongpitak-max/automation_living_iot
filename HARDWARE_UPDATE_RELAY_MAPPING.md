# HARDWARE CONFIGURATION UPDATE - RELAY MAPPING & CURTAIN REMOVAL

**Date**: 2026-09-04  
**Status**: ✅ COMPLETE - Ready for ESP32 Upload

---

## CHANGES SUMMARY

### 1. Relay Mapping Updated
### 2. 360° Curtain Servos Completely Removed

---

## OLD vs NEW RELAY MAPPING

### OLD Mapping (Incorrect Physical Wiring)

| GPIO | Device | Relay Channel | Status |
|------|--------|---------------|--------|
| 13 | Door Lock | IN1 | ❌ Wrong |
| 14 | Living LED | IN2 | ❌ Wrong |
| 25 | Living Fan | IN5 | ❌ Wrong |
| 27 | Kitchen LED | IN3 | ❌ Wrong |
| 33 | Kitchen Fan | IN6 | ❌ Wrong |
| 26 | Bedroom LED | IN4 | ❌ Wrong |
| 18 | Bedroom Fan | IN7 | ❌ Wrong |

### NEW Mapping (Matches Physical Wiring)

| GPIO | Device | Relay Channel | Status |
|------|--------|---------------|--------|
| 13 | Door Lock | IN8 | ✅ Correct |
| 14 | Living LED | IN7 | ✅ Correct |
| 25 | Living Fan | IN4 | ✅ Correct |
| 27 | Kitchen LED | IN6 | ✅ Correct |
| 33 | Kitchen Fan | IN3 | ✅ Correct |
| 26 | Bedroom LED | IN5 | ✅ Correct |
| 18 | Bedroom Fan | IN2 | ✅ Correct |

### Relay Channel Assignment (Final)

```
Relay IN1 = UNUSED / RESERVED
Relay IN2 = Bedroom Fan (GPIO 18)
Relay IN3 = Kitchen Exhaust Fan (GPIO 33)
Relay IN4 = Living Room Exhaust Fan (GPIO 25)
Relay IN5 = Bedroom LED (GPIO 26)
Relay IN6 = Kitchen LED (GPIO 27)
Relay IN7 = Living Room LED (GPIO 14)
Relay IN8 = LY-03 Door Lock (GPIO 13)
```

**All relays remain Active LOW**: LOW = ON, HIGH = OFF

---

## REMOVED: 360° Curtain Servos

### Devices Removed

1. **Bedroom Curtain Servo**
   - GPIO: 4
   - Type: 360° Continuous Rotation
   - Status: ❌ Completely removed

2. **Kitchen Curtain Servo**
   - GPIO: 23
   - Type: 360° Continuous Rotation
   - Status: ❌ Completely removed

### What Was Removed

#### ESP32 Firmware (`esp32/smart_home/smart_home.ino`)
- ✅ GPIO 4 and GPIO 23 removed from header comment
- ✅ Servo object declarations removed (`servoBedroomCurtain`, `servoKitchenCurtain`)
- ✅ State variables removed (`bedroomCurtain`, `kitchenCurtain`)
- ✅ Calibration constants removed (`BEDROOM_CURTAIN_STOP_US`, `KITCHEN_CURTAIN_STOP_US`)
- ✅ `set360Servo()` function removed
- ✅ MQTT subscription topics removed
- ✅ MQTT command handlers removed
- ✅ Status publish fields removed
- ✅ Servo attach/initialization removed from setup()

#### Frontend (`frontend/index.html`)
- ✅ Kitchen Curtain card removed (OPEN/STOP/CLOSE buttons)
- ✅ Bedroom Curtain card removed (OPEN/STOP/CLOSE buttons)
- ✅ `setKitchenCurtain()` function removed
- ✅ `setBedroomCurtain()` function removed
- ✅ `sendKitchenCurtain()` function removed
- ✅ `sendBedroomCurtain()` function removed
- ✅ State update calls removed from message handlers
- ✅ Relay channel labels updated for all devices

#### Backend (`backend/server.js`)
- ✅ Already clean - no curtain references found

---

## UNCHANGED DEVICES

### Relays (Active LOW)
- ✅ GPIO 13 → Door Lock (Relay IN8)
- ✅ GPIO 14 → Living LED (Relay IN7)
- ✅ GPIO 25 → Living Fan (Relay IN4)
- ✅ GPIO 27 → Kitchen LED (Relay IN6)
- ✅ GPIO 33 → Kitchen Fan (Relay IN3)
- ✅ GPIO 26 → Bedroom LED (Relay IN5)
- ✅ GPIO 18 → Bedroom Fan (Relay IN2)

### PWM AC Control
- ✅ GPIO 5 → Living AC (JZ-MOS1, PWM Channel 12)
- ✅ GPIO 21 → Bedroom AC (JZ-MOS2, PWM Channel 13)

### 180° Window Servos (KEPT)
- ✅ GPIO 22 → Kitchen Window (0-180°)
- ✅ GPIO 32 → Bedroom Window (0-180°)

### Sensors
- ✅ GPIO 19 → DHT22 Temperature/Humidity
- ✅ GPIO 34 → PIR Living Room
- ✅ GPIO 35 → PIR Bedroom
- ✅ GPIO 36 → PIR Kitchen

### AS608 Fingerprint
- ✅ GPIO 16 → RX (UART2)
- ✅ GPIO 17 → TX (UART2)

---

## FILES MODIFIED

### 1. ESP32 Firmware
**File**: `esp32/smart_home/smart_home.ino`

**Changes**:
- Updated GPIO mapping comment block (lines 1-22)
- Removed curtain GPIO pins (4, 23) from documentation
- Updated relay channel comments (IN8, IN7, IN6, IN5, IN4, IN3, IN2)
- Removed servo objects (servoBedroomCurtain, servoKitchenCurtain)
- Removed state variables (bedroomCurtain, kitchenCurtain)
- Removed calibration constants section
- Removed set360Servo() function
- Removed MQTT curtain subscriptions
- Removed MQTT curtain handlers
- Removed curtain status fields from publish functions
- Removed servo attach() calls for curtains in setup()

**Lines affected**: ~15 changes across the file

### 2. Frontend
**File**: `frontend/index.html`

**Changes**:
- Updated relay channel labels for all 7 devices
- Removed Kitchen Curtain card (OPEN/STOP/CLOSE UI)
- Removed Bedroom Curtain card (OPEN/STOP/CLOSE UI)
- Removed setKitchenCurtain() function
- Removed setBedroomCurtain() function
- Removed sendKitchenCurtain() function
- Removed sendBedroomCurtain() function
- Removed curtain state updates in message handlers

**Lines affected**: ~12 removals/updates

### 3. Backend
**File**: `backend/server.js`

**Status**: ✅ No changes needed - already clean

---

## GPIO PIN USAGE SUMMARY

### Active Pins (17 total)

| GPIO | Function | Type | Notes |
|------|----------|------|-------|
| 5 | Living AC | PWM Output | JZ-MOS1 |
| 13 | Door Lock | Relay Output | IN8 Active LOW |
| 14 | Living LED | Relay Output | IN7 Active LOW |
| 16 | AS608 RX | UART Input | Reserved |
| 17 | AS608 TX | UART Output | Reserved |
| 18 | Bedroom Fan | Relay Output | IN2 Active LOW |
| 19 | DHT22 | Digital I/O | Temperature/Humidity |
| 21 | Bedroom AC | PWM Output | JZ-MOS2 |
| 22 | Kitchen Window | Servo PWM | 180° positional |
| 25 | Living Fan | Relay Output | IN4 Active LOW |
| 26 | Bedroom LED | Relay Output | IN5 Active LOW |
| 27 | Kitchen LED | Relay Output | IN6 Active LOW |
| 32 | Bedroom Window | Servo PWM | 180° positional |
| 33 | Kitchen Fan | Relay Output | IN3 Active LOW |
| 34 | PIR Living | Digital Input | Input-only |
| 35 | PIR Bedroom | Digital Input | Input-only |
| 36 | PIR Kitchen | Digital Input | Input-only |

### Freed Pins (2 total)

| GPIO | Previous Function | Status |
|------|-------------------|--------|
| 4 | Bedroom Curtain Servo | ✅ Now available |
| 23 | Kitchen Curtain Servo | ✅ Now available |

---

## VERIFICATION CHECKLIST

### ESP32 Firmware ✅
- [x] GPIO mapping comment updated
- [x] Relay channel comments updated (IN8, IN7, IN6, IN5, IN4, IN3, IN2)
- [x] Curtain servo objects removed
- [x] Curtain state variables removed
- [x] Calibration constants removed
- [x] set360Servo() function removed
- [x] MQTT curtain subscriptions removed
- [x] MQTT curtain handlers removed
- [x] Curtain status fields removed
- [x] Servo initialization removed
- [x] Window servos (GPIO 22, 32) preserved

### Frontend ✅
- [x] Relay labels updated with IN channels
- [x] Kitchen Curtain card removed
- [x] Bedroom Curtain card removed
- [x] setKitchenCurtain() removed
- [x] setBedroomCurtain() removed
- [x] sendKitchenCurtain() removed
- [x] sendBedroomCurtain() removed
- [x] State handlers cleaned
- [x] Window controls preserved

### Backend ✅
- [x] No curtain references found
- [x] Server.js already clean

---

## NEXT STEPS

### 1. Compile ESP32 Firmware
```
Arduino IDE → Verify Button
Expected: Compilation successful
Expected Memory: ~35-40% program, ~15-20% RAM
```

### 2. Upload to ESP32
```
Arduino IDE → Upload Button
Monitor Serial: 115200 baud
Expected: WiFi OK, MQTT OK
```

### 3. Test Each Device
- Door Lock (GPIO 13 → Relay IN8)
- Living LED (GPIO 14 → Relay IN7)
- Living Fan (GPIO 25 → Relay IN4)
- Kitchen LED (GPIO 27 → Relay IN6)
- Kitchen Fan (GPIO 33 → Relay IN3)
- Bedroom LED (GPIO 26 → Relay IN5)
- Bedroom Fan (GPIO 18 → Relay IN2)
- Living AC (GPIO 5)
- Bedroom AC (GPIO 21)
- Kitchen Window (GPIO 22)
- Bedroom Window (GPIO 32)
- DHT22 sensor
- PIR sensors (3x)

---

## EXPECTED RESULTS

### Serial Monitor Output
```
=== Smart Home IoT System ===
Initializing...
[GPIO] Relays initialized (all OFF)
[GPIO] PWM initialized (channels 12, 13)
[GPIO] Servos initialized
[GPIO] PIR sensors initialized
[GPIO] DHT22 initialized
[GPIO] AS608 UART ready (not implemented yet)
[WiFi] Connecting to ROV...........
[WiFi] OK
[WiFi] IP: 10.70.66.XXX
[MQTT] Client configured
=== Initialization Complete ===

[MQTT] Connecting to ...hivemq.cloud... OK
```

### Dashboard Status
- ✅ ESP32 Online (green dot)
- ✅ All 7 relays respond to commands
- ✅ Both AC controls work
- ✅ Both window servos work
- ✅ Sensors publish data
- ❌ No curtain controls visible (correctly removed)

---

## SUMMARY

**Relay Mapping**: ✅ Updated to match physical wiring  
**Curtain Servos**: ✅ Completely removed from all layers  
**Window Servos**: ✅ Preserved and unchanged  
**Compilation**: ⏳ Pending user action  
**Physical Test**: ⏳ Pending upload and verification

**Status**: READY FOR ARDUINO IDE COMPILATION AND UPLOAD

---

*Document Generated: 2026-09-04*  
*Relay Channels: IN8, IN7, IN6, IN5, IN4, IN3, IN2 (IN1 unused)*  
*Removed: GPIO 4 and GPIO 23 (360° curtain servos)*  
*Preserved: GPIO 22 and GPIO 32 (180° window servos)*
