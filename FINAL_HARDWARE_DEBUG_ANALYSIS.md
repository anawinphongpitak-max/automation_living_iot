# FINAL HARDWARE DEBUGGING - ANALYSIS REPORT

**Date**: 2026-09-01  
**Status**: Two Issues Identified

---

## ISSUE 1 ANALYSIS: 360° CURTAIN SERVO STOP FAILURE

### Current STOP Implementation

**File**: `esp32/smart_home/smart_home.ino` (Lines 154-164)

```cpp
void set360Servo(Servo &servo, String action) {
  // 360° servo: speed/direction control
  // Typical: 0°=full CCW, 90°=stop, 180°=full CW
  if (action == "open") {
    servo.write(180);  // Full speed clockwise
  } else if (action == "close") {
    servo.write(0);    // Full speed counter-clockwise
  } else {
    servo.write(90);   // Stop
  }
}
```

### Problem Identified

**Assumption**: `servo.write(90)` is the universal STOP position for all continuous rotation servos.

**Reality**: Each 360° servo has a slightly different neutral point due to manufacturing tolerances. The actual STOP value may be 88°, 92°, 85°, or any value near 90°.

**Current behavior**: Both servos use hardcoded `90`, which may not be the true neutral point for either physical servo.

### Root Cause

**No per-servo calibration** - Both Bedroom Curtain (GPIO 4) and Kitchen Curtain (GPIO 23) use the same STOP value, but they are separate physical servos with different neutral points.

---

## ISSUE 2 ANALYSIS: BEDROOM AC WEAKER AT 100%

### Current AC PWM Implementation

**File**: `esp32/smart_home/smart_home.ino` (Lines 145-152)

```cpp
void setAC(int channel, int level) {
  // level: 0, 70, 90, 100
  int duty = 0;
  if (level == 70)       duty = 179;  // ~70% of 255
  else if (level == 90)  duty = 230;  // ~90% of 255
  else if (level == 100) duty = 255;  // 100%
  ledcWrite(channel, duty);
}
```

### PWM Configuration

```cpp
#define PWM_FREQ            1000      // 1 kHz
#define PWM_RESOLUTION      8         // 8-bit
#define PWM_CHANNEL_LIVING  12        // Living AC
#define PWM_CHANNEL_BEDROOM 13        // Bedroom AC
```

### Comparison: Living AC vs Bedroom AC

| Parameter | Living AC (GPIO 5) | Bedroom AC (GPIO 21) |
|-----------|-------------------|---------------------|
| PWM Channel | 12 | 13 |
| Frequency | 1000 Hz | 1000 Hz |
| Resolution | 8-bit | 8-bit |
| 100% Duty | 255 | 255 |
| Function Call | `setAC(PWM_CHANNEL_LIVING, 100)` | `setAC(PWM_CHANNEL_BEDROOM, 100)` |
| Duty Written | `ledcWrite(12, 255)` | `ledcWrite(13, 255)` |

### Analysis Result

**Software is IDENTICAL for both devices at 100%**:
- Same frequency (1000 Hz)
- Same resolution (8-bit)
- Same duty value (255 out of 255)
- Same `setAC()` function logic

**No software difference detected.**

### Problem Identified

**Missing diagnostics** - No Serial output to confirm the actual duty value being written to each channel during operation.

Without runtime diagnostics, we cannot verify:
1. Whether `setAC()` is actually called with level 100 for both devices
2. Whether the correct channel is being written
3. Whether the duty value is correctly calculated and written

---

## PROPOSED MINIMAL FIXES

### Fix 1: Add Per-Servo STOP Calibration

**Approach**: Create adjustable calibration constants for each servo's neutral point.

**New Constants** (add after PWM configuration):
```cpp
// ===== 360° Servo Calibration =====
// Adjust these values to find the exact STOP position for each servo
// Typical range: 85-95 (default 90)
#define BEDROOM_CURTAIN_STOP  90  // Start at 90, adjust ±5 during testing
#define KITCHEN_CURTAIN_STOP  90  // Start at 90, adjust ±5 during testing
```

**Modified Function**:
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

**Call Sites Updated**:
```cpp
// Bedroom Curtain
set360Servo(servoBedroomCurtain, bedroomCurtain, BEDROOM_CURTAIN_STOP);

// Kitchen Curtain
set360Servo(servoKitchenCurtain, kitchenCurtain, KITCHEN_CURTAIN_STOP);
```

### Calibration Procedure for User

1. Upload firmware with both values at 90
2. Test Bedroom Curtain:
   - Send STOP command
   - If servo still rotates CW, decrease BEDROOM_CURTAIN_STOP by 1
   - If servo still rotates CCW, increase BEDROOM_CURTAIN_STOP by 1
   - Repeat until servo stops completely
3. Test Kitchen Curtain:
   - Send STOP command
   - If servo still rotates CW, decrease KITCHEN_CURTAIN_STOP by 1
   - If servo still rotates CCW, increase KITCHEN_CURTAIN_STOP by 1
   - Repeat until servo stops completely
4. Final values may be different (e.g., Bedroom=88, Kitchen=92)

---

### Fix 2: Add AC PWM Diagnostics

**Modified Function**:
```cpp
void setAC(int channel, int level) {
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
```

**Expected Serial Output**:
```
[AC] Channel 12 Level: 100% Duty: 255 / 255  (Living AC)
[AC] Channel 13 Level: 100% Duty: 255 / 255  (Bedroom AC)
```

This will confirm whether both channels receive identical duty values at 100%.

---

## SUMMARY

### Issue 1: Curtain Servo STOP
**Root Cause**: Hardcoded STOP value (90) does not match physical servo neutral points  
**Software Issue**: YES - missing per-servo calibration  
**Fix**: Add adjustable calibration constants and diagnostics  

### Issue 2: Bedroom AC Weaker at 100%
**Root Cause**: Unknown - software configuration is identical  
**Software Issue**: NO - code is correct and identical for both devices  
**Fix**: Add diagnostics to verify runtime behavior; likely hardware/power issue  

---

**Ready to implement fixes. Waiting for confirmation before proceeding.**
