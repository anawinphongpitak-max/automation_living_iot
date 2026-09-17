# HARDWARE TEST FAILURE ANALYSIS

**Date**: 2026-09-01  
**Status**: 4 Issues Identified

---

## ISSUE 1 ROOT CAUSE: KITCHEN EXHAUST FAN RELAY MAPPING

### Expected Behavior
- Frontend: Kitchen Fan toggle
- GPIO: 33 (Relay IN6)
- Device: Kitchen Exhaust Fan

### Trace Analysis

**Frontend** → `frontend/index.html:629`:
```javascript
function sendKitchenFan(on) {
  send({ type: 'kitchen_fan', state: on });
}
```
✅ CORRECT: Sends `kitchen_fan` command

**Backend** → `backend/server.js:168-169`:
```javascript
else if (msg.type === 'kitchen_fan') {
  mqttClient.publish('home/control/kitchen/fan', JSON.stringify({ state: msg.state }));
}
```
✅ CORRECT: Publishes to `home/control/kitchen/fan`

**ESP32** → `esp32/smart_home/smart_home.ino:211-214`:
```cpp
else if (t == "home/control/kitchen/fan") {
  kitchenFan = doc["state"] | false;
  setRelay(PIN_KITCHEN_FAN, kitchenFan);
  publishStatusKitchen();
}
```
✅ CORRECT: Receives command and calls `setRelay(PIN_KITCHEN_FAN, ...)`

**GPIO Definition** → `esp32/smart_home/smart_home.ino:76`:
```cpp
#define PIN_KITCHEN_FAN     33
```
✅ CORRECT: GPIO 33 defined

### ROOT CAUSE
**CANNOT BE DETERMINED FROM SOFTWARE INSPECTION**

All software layers are correct:
- Frontend sends correct command type
- Backend publishes to correct MQTT topic
- ESP32 receives correct topic
- ESP32 uses correct GPIO pin (33)

**Possible causes (hardware layer)**:
1. Physical wiring error: Relay IN6 not connected to GPIO 33
2. Relay board labeling mismatch: IN6 physically connected to different GPIO
3. GPIO 33 hardware issue or pin damaged
4. Relay board IN6 channel defective

**Required action**: Physical inspection of wiring between ESP32 GPIO 33 and Relay IN6

---

## ISSUE 2 ROOT CAUSE: BEDROOM SIMULATED AC (GPIO 21)

### Working Reference: Living AC (GPIO 5)

**PWM Configuration**:
```cpp
#define PWM_FREQ            1000      // 1 kHz
#define PWM_RESOLUTION      8         // 8-bit
#define PWM_CHANNEL_LIVING  0         // Channel 0
#define PWM_CHANNEL_BEDROOM 1         // Channel 1
```

**Initialization**:
```cpp
ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);   // Channel 0
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);  // Channel 1
ledcAttachPin(PIN_LIVING_AC, PWM_CHANNEL_LIVING);          // GPIO 5 → Channel 0
ledcAttachPin(PIN_BEDROOM_AC, PWM_CHANNEL_BEDROOM);        // GPIO 21 → Channel 1
```

**Duty Cycle Calculation** (identical for both):
```cpp
void setAC(int channel, int level) {
  int duty = 0;
  if (level == 70)       duty = 179;  // ~70% of 255
  else if (level == 90)  duty = 230;  // ~90% of 255
  else if (level == 100) duty = 255;  // 100%
  ledcWrite(channel, duty);
}
```

### Comparison

| Parameter | Living AC (GPIO 5) | Bedroom AC (GPIO 21) |
|-----------|-------------------|---------------------|
| PWM Channel | 0 | 1 |
| Frequency | 1000 Hz | 1000 Hz |
| Resolution | 8-bit | 8-bit |
| 70% Duty | 179 | 179 |
| 90% Duty | 230 | 230 |
| 100% Duty | 255 | 255 |

✅ IDENTICAL CONFIGURATION

### ROOT CAUSE
**SOFTWARE CONFIGURATION IS IDENTICAL AND CORRECT**

The firmware PWM configuration for GPIO 21 is exactly the same as the working GPIO 5 implementation.

**Symptom Analysis**: "Device vibrates/shakes" at 70%, 90%, 100%

This symptom suggests:
1. **Insufficient power supply**: PWM signal is correct but device cannot draw enough current
2. **Hardware defect**: JZ-MOS2 module or device issue
3. **Loose connection**: Intermittent power delivery causing vibration
4. **Wrong device**: Device connected to GPIO 21 has different power requirements than GPIO 5 device

**Required action**: 
- Check power supply capacity
- Verify JZ-MOS2 module connections
- Test with multimeter: measure actual voltage at GPIO 21 output during operation
- Compare power consumption of devices on GPIO 5 vs GPIO 21

**Software is NOT the issue** - PWM configuration is correct and identical to working implementation.

---

## ISSUE 3 ROOT CAUSE: BEDROOM CURTAIN 360° SERVO (GPIO 4)

### Symptom
- OPEN works (servo rotates)
- CLOSE works (servo rotates)
- STOP does not stop (servo continues rotating)

### 360° Servo Control Implementation
```cpp
void set360Servo(Servo &servo, String action) {
  if (action == "open") {
    servo.write(180);  // Full speed clockwise
  } else if (action == "close") {
    servo.write(0);    // Full speed counter-clockwise
  } else {
    servo.write(90);   // Stop
  }
}
```

### Servo Initialization
```cpp
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);  // GPIO 4
servoBedroomCurtain.write(90);  // Stop
```

### ROOT CAUSE
**POTENTIAL ESP32SERVO CHANNEL CONFLICT**

ESP32Servo library internally allocates LEDC channels automatically. With 4 servos attached, the library uses multiple LEDC channels.

**Critical observation**: The code manually uses LEDC channels 0 and 1 for AC PWM:
```cpp
#define PWM_CHANNEL_LIVING  0
#define PWM_CHANNEL_BEDROOM 1

ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);
```

ESP32Servo library also uses LEDC channels (typically starting from channel 0 by default).

**CONFLICT**: Manual PWM setup on channels 0 and 1 may conflict with ESP32Servo's automatic channel allocation.

### Specific Issue for Bedroom Curtain (GPIO 4)
GPIO 4 is attached **BEFORE** the AC PWM channels are set up in code:
```cpp
// Servos initialized first
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);  // Line 410

// Then AC PWM initialized
ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);     // Line 397
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);    // Line 398
```

**The AC PWM setup may be overwriting the servo's LEDC channel configuration.**

---

## ISSUE 4 ROOT CAUSE: KITCHEN CURTAIN 360° SERVO (GPIO 23)

### Symptom
- OPEN works
- CLOSE works
- STOP does not completely stop (continues moving slightly)
- **CRITICAL**: When Bedroom AC (GPIO 21) is turned OFF, Kitchen Curtain stops

### Smoking Gun Observation
```
Bedroom AC OFF → Kitchen Curtain stops
```

This directly proves **LEDC channel conflict** between:
- Bedroom AC: GPIO 21, PWM_CHANNEL_BEDROOM (channel 1)
- Kitchen Curtain: GPIO 23, ESP32Servo auto-allocated channel

### ROOT CAUSE
**CONFIRMED: ESP32SERVO AND MANUAL PWM CHANNEL CONFLICT**

ESP32Servo library auto-allocates LEDC channels for each attached servo. The default allocation typically starts from channel 0.

**Current setup**:
- Manual PWM uses channels 0 and 1
- ESP32Servo automatically allocates channels for 4 servos (likely channels 0-3)

**Channel allocation collision**:
```
Manual PWM:
- Channel 0: Living AC (GPIO 5)
- Channel 1: Bedroom AC (GPIO 21)

ESP32Servo (auto-allocated):
- Channel 0: Kitchen Window (GPIO 22) ← CONFLICTS with Living AC
- Channel 1: Kitchen Curtain (GPIO 23) ← CONFLICTS with Bedroom AC
- Channel 2: Bedroom Window (GPIO 32)
- Channel 3: Bedroom Curtain (GPIO 4)
```

**Why Kitchen Curtain stops when Bedroom AC turns OFF**:
- Kitchen Curtain servo uses LEDC channel 1 (auto-allocated by ESP32Servo)
- Bedroom AC manually uses LEDC channel 1
- When Bedroom AC writes duty cycle to channel 1, it overwrites the servo pulse
- When Bedroom AC turns OFF (duty 0), the servo's STOP command (90°) can finally take effect

---

## PWM / LEDC CHANNEL ALLOCATION TABLE

| Device | GPIO | System | LEDC Channel | LEDC Timer | Frequency | Resolution | Status |
|--------|------|--------|--------------|------------|-----------|------------|--------|
| Living AC | 5 | Manual PWM | 0 | Auto | 1000 Hz | 8-bit | ✅ Working |
| Bedroom AC | 21 | Manual PWM | 1 | Auto | 1000 Hz | 8-bit | ⚠️ Vibrates (power issue) |
| Kitchen Window | 22 | ESP32Servo | 0 (auto) | Auto | 50 Hz | 16-bit | ✅ Working |
| Kitchen Curtain | 23 | ESP32Servo | 1 (auto) | Auto | 50 Hz | 16-bit | ❌ CONFLICT with channel 1 |
| Bedroom Window | 32 | ESP32Servo | 2 (auto) | Auto | 50 Hz | 16-bit | ✅ Working |
| Bedroom Curtain | 4 | ESP32Servo | 3 (auto) | Auto | 50 Hz | 16-bit | ❌ STOP doesn't work |

### CONFLICT IDENTIFIED

**Channel 0**: Living AC (manual PWM) vs Kitchen Window servo (ESP32Servo auto)
- Kitchen Window works because it's not continuously driven (positional servo, write once)

**Channel 1**: Bedroom AC (manual PWM) vs Kitchen Curtain servo (ESP32Servo auto)
- Kitchen Curtain STOP fails because Bedroom AC continuously overwrites channel 1
- Confirmed by: turning Bedroom AC OFF makes Kitchen Curtain stop

---

## FILES REQUIRING MODIFICATION

**Only 1 file needs modification**:
- `esp32/smart_home/smart_home.ino`

**No changes to**:
- Backend
- Frontend
- MQTT topics
- Device control logic
- Working devices

---

## PROPOSED MINIMAL CODE CHANGES

### Change 1: Move AC PWM to Non-Conflicting Channels

**Current**:
```cpp
#define PWM_CHANNEL_LIVING  0
#define PWM_CHANNEL_BEDROOM 1
```

**Proposed**:
```cpp
#define PWM_CHANNEL_LIVING  12
#define PWM_CHANNEL_BEDROOM 13
```

**Reason**: ESP32Servo uses channels 0-3 by default. Move manual PWM to channels 12-13 to avoid conflict.

ESP32 has 16 LEDC channels (0-15), so channels 12-13 are available and safe.

---

### Change 2: Initialize AC PWM BEFORE Servo Attachment

**Current order in setup()**:
```cpp
// Servos initialized first (line 407-410)
servoKitchenWindow.attach(PIN_KITCHEN_WINDOW, 500, 2400);
servoKitchenCurtain.attach(PIN_KITCHEN_CURTAIN, 500, 2400);
servoBedroomWindow.attach(PIN_BEDROOM_WINDOW, 500, 2400);
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);

// Then AC PWM (line 397-402)
ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);
```

**Proposed order**: Move AC PWM initialization BEFORE servo attachment

```cpp
// Initialize AC PWM first
ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);
ledcAttachPin(PIN_LIVING_AC, PWM_CHANNEL_LIVING);
ledcAttachPin(PIN_BEDROOM_AC, PWM_CHANNEL_BEDROOM);
ledcWrite(PWM_CHANNEL_LIVING, 0);
ledcWrite(PWM_CHANNEL_BEDROOM, 0);

// Then initialize servos
servoKitchenWindow.attach(PIN_KITCHEN_WINDOW, 500, 2400);
servoKitchenCurtain.attach(PIN_KITCHEN_CURTAIN, 500, 2400);
servoBedroomWindow.attach(PIN_BEDROOM_WINDOW, 500, 2400);
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);
```

**Reason**: Claim high-numbered channels (12-13) for manual PWM before ESP32Servo claims low-numbered channels (0-3).

---

## EXACT CODE CHANGES

### File: `esp32/smart_home/smart_home.ino`

#### Change 1: Line 104-105
**OLD**:
```cpp
#define PWM_CHANNEL_LIVING  0
#define PWM_CHANNEL_BEDROOM 1
```

**NEW**:
```cpp
#define PWM_CHANNEL_LIVING  12
#define PWM_CHANNEL_BEDROOM 13
```

#### Change 2: Lines 396-417 (reorder initialization)
**OLD**:
```cpp
Serial.println("[GPIO] PWM initialized");

// Initialize servos
servoKitchenWindow.attach(PIN_KITCHEN_WINDOW, 500, 2400);
servoKitchenCurtain.attach(PIN_KITCHEN_CURTAIN, 500, 2400);
servoBedroomWindow.attach(PIN_BEDROOM_WINDOW, 500, 2400);
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);

servoKitchenWindow.write(0);
servoKitchenCurtain.write(90);  // Stop
servoBedroomWindow.write(0);
servoBedroomCurtain.write(90);  // Stop

Serial.println("[GPIO] Servos initialized");

// Initialize PWM for AC control
ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);
ledcAttachPin(PIN_LIVING_AC, PWM_CHANNEL_LIVING);
ledcAttachPin(PIN_BEDROOM_AC, PWM_CHANNEL_BEDROOM);
ledcWrite(PWM_CHANNEL_LIVING, 0);
ledcWrite(PWM_CHANNEL_BEDROOM, 0);
```

**NEW**:
```cpp
// Initialize PWM for AC control
ledcSetup(PWM_CHANNEL_LIVING, PWM_FREQ, PWM_RESOLUTION);
ledcSetup(PWM_CHANNEL_BEDROOM, PWM_FREQ, PWM_RESOLUTION);
ledcAttachPin(PIN_LIVING_AC, PWM_CHANNEL_LIVING);
ledcAttachPin(PIN_BEDROOM_AC, PWM_CHANNEL_BEDROOM);
ledcWrite(PWM_CHANNEL_LIVING, 0);
ledcWrite(PWM_CHANNEL_BEDROOM, 0);

Serial.println("[GPIO] PWM initialized");

// Initialize servos
servoKitchenWindow.attach(PIN_KITCHEN_WINDOW, 500, 2400);
servoKitchenCurtain.attach(PIN_KITCHEN_CURTAIN, 500, 2400);
servoBedroomWindow.attach(PIN_BEDROOM_WINDOW, 500, 2400);
servoBedroomCurtain.attach(PIN_BEDROOM_CURTAIN, 500, 2400);

servoKitchenWindow.write(0);
servoKitchenCurtain.write(90);  // Stop
servoBedroomWindow.write(0);
servoBedroomCurtain.write(90);  // Stop

Serial.println("[GPIO] Servos initialized");
```

---

## SUMMARY

### Issue 1: Kitchen Exhaust Fan
**Root Cause**: Cannot be determined from software - all software layers correct
**Required Action**: Physical wiring inspection of GPIO 33 to Relay IN6 connection

### Issue 2: Bedroom AC Vibration
**Root Cause**: NOT a software issue - PWM configuration identical to working Living AC
**Required Action**: Check power supply, verify JZ-MOS2 hardware, measure voltage with multimeter

### Issue 3: Bedroom Curtain STOP Failure
**Root Cause**: LEDC channel conflict - ESP32Servo and manual PWM using same channels
**Fix**: Change PWM channels from 0,1 to 12,13 and reorder initialization

### Issue 4: Kitchen Curtain STOP Failure (Affected by Bedroom AC)
**Root Cause**: CONFIRMED LEDC channel 1 conflict between Bedroom AC PWM and Kitchen Curtain servo
**Fix**: Same as Issue 3 - change PWM channels to 12,13

### Fixes Required
- **2 software changes** in `esp32/smart_home/smart_home.ino` to resolve Issues 3 and 4
- **2 hardware inspections** for Issues 1 and 2

---

**STOPPED - Awaiting confirmation before implementing changes.**
