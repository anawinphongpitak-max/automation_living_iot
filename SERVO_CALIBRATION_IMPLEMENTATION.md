# 360° SERVO CALIBRATION - MICROSECOND IMPLEMENTATION

**Date**: 2026-09-01  
**Status**: ✅ CODE COMPLETE - READY FOR PHYSICAL TESTING

---

## IMPLEMENTATION SUMMARY

### Problem Identified
- **servo.write()** method FAILED - tested values 85-95, both servos still moved
- Root cause: Degree-based control insufficient granularity for neutral point calibration
- Manufacturing tolerances require precise microsecond-level control

### Solution Implemented
- **servo.writeMicroseconds()** method with 1450-1550µs calibration range
- Per-servo adjustable constants for independent calibration
- Diagnostic output for verification during testing

---

## CODE CHANGES

### File Modified
**esp32/smart_home/smart_home.ino**

### Change 1: Calibration Constants (Lines 107-112)

**OLD**:
```cpp
// ===== 360° Servo Calibration =====
// Adjust these values to find the exact STOP position for each servo
// Typical range: 85-95 (default 90)
#define BEDROOM_CURTAIN_STOP  90  // Start at 90, adjust ±5 during testing
#define KITCHEN_CURTAIN_STOP  90  // Start at 90, adjust ±5 during testing
```

**NEW**:
```cpp
// ===== 360° Servo Calibration =====
// Adjust these microsecond values to find exact STOP position for each servo
// Typical neutral point: ~1500 microseconds
// Test range: 1450-1550 (adjust in 10 microsecond increments)
#define BEDROOM_CURTAIN_STOP_US  1500  // Start at 1500, adjust ±50
#define KITCHEN_CURTAIN_STOP_US  1500  // Start at 1500, adjust ±50
```

**Changes**:
- Renamed from `_STOP` to `_STOP_US` for clarity
- Changed from degrees (85-95) to microseconds (1450-1550)
- Starting point: 1500µs (typical neutral)
- Test range: ±50µs in 10µs increments

---

### Change 2: set360Servo() Function (Lines 170-185)

**OLD**:
```cpp
void set360Servo(Servo &servo, String action, int stopValue) {
  if (action == "open") {
    servo.write(180);
    Serial.println("[SERVO] OPEN (180)");
  } else if (action == "close") {
    servo.write(0);
    Serial.println("[SERVO] CLOSE (0)");
  } else {
    servo.write(stopValue);
    Serial.print("[SERVO] STOP (");
    Serial.print(stopValue);
    Serial.println(")");
  }
}
```

**NEW**:
```cpp
void set360Servo(Servo &servo, String action, int stopMicroseconds) {
  // 360° servo: speed/direction control using microseconds
  // 1000µs=full CCW, stopMicroseconds=neutral, 2000µs=full CW
  if (action == "open") {
    servo.writeMicroseconds(2000);  // Full speed clockwise
    Serial.println("[SERVO] OPEN (2000µs)");
  } else if (action == "close") {
    servo.writeMicroseconds(1000);  // Full speed counter-clockwise
    Serial.println("[SERVO] CLOSE (1000µs)");
  } else {
    servo.writeMicroseconds(stopMicroseconds);  // Calibrated stop position
    Serial.print("[SERVO] STOP (");
    Serial.print(stopMicroseconds);
    Serial.println("µs)");
  }
}
```

**Changes**:
- `servo.write()` → `servo.writeMicroseconds()`
- OPEN: 180° → 2000µs (full CW speed)
- CLOSE: 0° → 1000µs (full CCW speed)
- STOP: variable degree → variable microseconds
- Parameter renamed: `stopValue` → `stopMicroseconds`
- Diagnostic output shows microseconds instead of degrees

---

### Change 3: Kitchen Curtain Call Site (Line ~244)

**OLD**:
```cpp
set360Servo(servoKitchenCurtain, kitchenCurtain, KITCHEN_CURTAIN_STOP);
```

**NEW**:
```cpp
set360Servo(servoKitchenCurtain, kitchenCurtain, KITCHEN_CURTAIN_STOP_US);
```

---

### Change 4: Bedroom Curtain Call Site (Line ~270)

**OLD**:
```cpp
set360Servo(servoBedroomCurtain, bedroomCurtain, BEDROOM_CURTAIN_STOP);
```

**NEW**:
```cpp
set360Servo(servoBedroomCurtain, bedroomCurtain, BEDROOM_CURTAIN_STOP_US);
```

---

## VERIFICATION

All calibration constant references updated:
```
#define BEDROOM_CURTAIN_STOP_US  1500
#define KITCHEN_CURTAIN_STOP_US  1500

set360Servo(servoKitchenCurtain, kitchenCurtain, KITCHEN_CURTAIN_STOP_US);
set360Servo(servoBedroomCurtain, bedroomCurtain, BEDROOM_CURTAIN_STOP_US);
```

✅ All references use `_STOP_US` suffix consistently

---

## CALIBRATION PROCEDURE FOR USER

### Step 1: Upload Firmware
1. Open Arduino IDE
2. Compile firmware (verify no errors)
3. Upload to ESP32
4. Open Serial Monitor (115200 baud)

### Step 2: Test Bedroom Curtain
1. Send STOP command from dashboard
2. Observe Serial Monitor output:
   ```
   [SERVO] STOP (1500µs)
   ```
3. **If servo rotates clockwise**: Decrease value by 10
   - Change `#define BEDROOM_CURTAIN_STOP_US  1490`
4. **If servo rotates counter-clockwise**: Increase value by 10
   - Change `#define BEDROOM_CURTAIN_STOP_US  1510`
5. Repeat upload and test until servo stops completely

### Step 3: Test Kitchen Curtain
1. Send STOP command from dashboard
2. Observe Serial Monitor output:
   ```
   [SERVO] STOP (1500µs)
   ```
3. **If servo rotates clockwise**: Decrease value by 10
   - Change `#define KITCHEN_CURTAIN_STOP_US  1490`
4. **If servo rotates counter-clockwise**: Increase value by 10
   - Change `#define KITCHEN_CURTAIN_STOP_US  1510`
5. Repeat upload and test until servo stops completely

### Expected Results
- Bedroom Curtain: Final value may be 1450-1550µs (likely different from 1500)
- Kitchen Curtain: Final value may be 1450-1550µs (likely different from 1500)
- **Two servos may have different neutral points** (e.g., Bedroom=1480, Kitchen=1520)

---

## TECHNICAL NOTES

### Why writeMicroseconds() vs write()

**servo.write(angle)**:
- Maps 0-180 to pulse width internally
- Granularity: ~5.55µs per degree (1000µs range / 180 steps)
- At 90°: ~1500µs
- At 89°: ~1494µs (6µs jump)
- At 91°: ~1506µs (6µs jump)
- **Problem**: 6µs jumps too coarse for neutral point calibration

**servo.writeMicroseconds(us)**:
- Direct microsecond control
- Granularity: 1µs per step
- Can test: 1500, 1490, 1480, 1470... (10µs increments)
- **Solution**: Fine control for precise neutral point

### 360° Servo Control Range
- **1000µs**: Full speed counter-clockwise (CLOSE)
- **1450-1550µs**: Neutral zone (STOP - varies by servo)
- **2000µs**: Full speed clockwise (OPEN)

### Why ±50µs Range
- Typical servo neutral: 1500µs ±50µs due to manufacturing tolerances
- Some servos may be outside this range (1400-1600µs possible)
- Start at 1500µs, adjust in 10µs increments

---

## UNCHANGED COMPONENTS

✅ GPIO assignments (all 19 pins)
✅ PWM channels 12 and 13
✅ AC control (setAC function)
✅ Relay control (Active LOW logic)
✅ MQTT topics
✅ Backend server
✅ Frontend dashboard
✅ 180° window servos
✅ Sensors (DHT22, PIR)

---

## NEXT STEPS

### User Action Required
1. Compile firmware in Arduino IDE
2. Upload to ESP32
3. Test STOP calibration for both servos
4. Report results:
   - Bedroom Curtain final microsecond value
   - Kitchen Curtain final microsecond value
   - Whether STOP now works correctly

### Expected Serial Monitor Output
```
[MQTT] home/control/bedroom/curtain -> {"action":"stop"}
[SERVO] STOP (1500µs)

[MQTT] home/control/kitchen/curtain -> {"action":"stop"}
[SERVO] STOP (1500µs)
```

If servos still rotate after STOP command, adjust constants and re-upload.

---

## STATUS

**Code Implementation**: ✅ COMPLETE  
**Firmware Compilation**: ⏳ PENDING (User action)  
**Physical Testing**: ⏳ PENDING (User action)  
**Calibration**: ⏳ PENDING (User action)

**Waiting for**: User to compile, upload, and test microsecond-based calibration

---

*Implementation Date: 2026-09-01*  
*Method: servo.writeMicroseconds() with adjustable µs constants*  
*Test Range: 1450-1550µs in 10µs increments*
