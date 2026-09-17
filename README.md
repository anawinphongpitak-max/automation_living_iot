# 🏠 Smart Home IoT Dashboard - Multi-Room Control System

Complete ESP32-based smart home system with 3-room control, sensors, and real-time web dashboard.

---

## 📋 Hardware Components

| Component | Quantity | GPIO Pins |
|-----------|----------|-----------|
| ESP32 DevKit V1 | 1 | — |
| DHT22 Temperature/Humidity | 1 | GPIO 19 |
| PIR Motion Sensors | 3 | GPIO 34, 35, 36 |
| Relay Module (Active LOW) | 7 | GPIO 13, 14, 18, 25, 26, 27, 33 |
| 180° Servo (Window) | 2 | GPIO 22, 32 |
| 360° Servo (Curtain) | 2 | GPIO 4, 23 |
| JZ-MOS PWM AC Control | 2 | GPIO 5, 21 |
| AS608 Fingerprint Sensor | 1 | GPIO 16/17 (UART2) |

---

## 🗂️ Complete GPIO Mapping

### Relays (Active LOW: LOW=ON, HIGH=OFF)
```
GPIO 13 → Door Lock (Relay IN1)
GPIO 14 → Living Room LED (Relay IN2)
GPIO 25 → Living Room Exhaust Fan (Relay IN5)
GPIO 27 → Kitchen LED (Relay IN3)
GPIO 33 → Kitchen Exhaust Fan (Relay IN6)
GPIO 26 → Bedroom LED (Relay IN4)
GPIO 18 → Bedroom Fan (Relay IN7)
```

### PWM Outputs (AC Simulation)
```
GPIO 5  → Living Room AC (JZ-MOS1) - 70%, 90%, 100%
GPIO 21 → Bedroom AC (JZ-MOS2) - 70%, 90%, 100%
```

### Servos
```
GPIO 22 → Kitchen Window (180° Servo)
GPIO 23 → Kitchen Curtain (360° Servo)
GPIO 32 → Bedroom Window (180° Servo)
GPIO 4  → Bedroom Curtain (360° Servo)
```

### Sensors
```
GPIO 19 → DHT22 Temperature/Humidity Sensor
GPIO 34 → PIR Motion Sensor (Living Room)
GPIO 35 → PIR Motion Sensor (Bedroom)
GPIO 36 → PIR Motion Sensor (Kitchen)
```

### Fingerprint Module
```
GPIO 16 → AS608 RX (UART2)
GPIO 17 → AS608 TX (UART2)
```

---

## 🏗️ Project Structure

```
automation_living_iot_v2/
├── backend/
│   ├── .env              ← MQTT credentials (DO NOT COMMIT)
│   ├── .env.example      ← Template for configuration
│   ├── package.json      ← Dependencies
│   └── server.js         ← Node.js backend (MQTT + WebSocket)
├── frontend/
│   └── index.html        ← Web dashboard (single file)
├── esp32/
│   └── smart_home/
│       └── smart_home.ino ← ESP32 firmware
└── README.md
```

---

## 🔧 Installation

### 1. Backend Setup

```bash
cd backend
npm install
```

Create `.env` file (copy from `.env.example`):
```env
MQTT_BROKER=mqtts://your-hivemq-host.hivemq.cloud:8883
MQTT_USERNAME=your-username
MQTT_PASSWORD=your-password
PORT=3000
```

Start the server:
```bash
npm start
```

Open dashboard: `http://localhost:3000`

### 2. ESP32 Setup

**Required Arduino Libraries:**
- `PubSubClient` (MQTT client)
- `ArduinoJson` (JSON parsing)
- `DHT sensor library` by Adafruit
- `ESP32Servo`

**Configure WiFi & MQTT in `smart_home.ino`:**
```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char* MQTT_SERVER = "your-broker.hivemq.cloud";
const char* MQTT_USER   = "your-username";
const char* MQTT_PASS   = "your-password";
```

**Upload to ESP32:**
1. Select **Board: ESP32 Dev Module**
2. Select correct **Port**
3. Click **Upload**

---

## 📡 MQTT Topics

### Command Topics (Backend → ESP32)
```
home/control/door                 {"locked": true|false}
home/control/living/led           {"state": true|false}
home/control/living/fan           {"state": true|false}
home/control/living/ac            {"level": 0|70|90|100}
home/control/kitchen/led          {"state": true|false}
home/control/kitchen/fan          {"state": true|false}
home/control/kitchen/window       {"angle": 0-180}
home/control/kitchen/curtain      {"action": "open"|"stop"|"close"}
home/control/bedroom/led          {"state": true|false}
home/control/bedroom/fan          {"state": true|false}
home/control/bedroom/ac           {"level": 0|70|90|100}
home/control/bedroom/window       {"angle": 0-180}
home/control/bedroom/curtain      {"action": "open"|"stop"|"close"}
```

### Status Topics (ESP32 → Backend)
```
home/status/door                  {"locked": true|false}
home/status/living                {"led": bool, "exhaustFan": bool, "ac": int}
home/status/kitchen               {"led": bool, "exhaustFan": bool, "window": int, "curtain": string}
home/status/bedroom               {"led": bool, "fan": bool, "ac": int, "window": int, "curtain": string}
```

### Sensor Topics (ESP32 → Backend)
```
home/sensor/dht22                 {"temp": 28.5, "hum": 65.2}
home/sensor/pir/living            {"pir": 0|1}
home/sensor/pir/kitchen           {"pir": 0|1}
home/sensor/pir/bedroom           {"pir": 0|1}
home/sensor/fingerprint           {"id": int, "event": "match"|"unknown"}
```

---

## 🎛️ Device Control

### Door
- **Lock/Unlock** via toggle switch
- GPIO 13 relay controls electric door lock

### Living Room
- **LED Light** ON/OFF
- **Exhaust Fan** ON/OFF
- **AC Simulation** OFF / 70% / 90% / 100%
- **PIR Motion** detection display

### Kitchen
- **LED Light** ON/OFF
- **Exhaust Fan** ON/OFF
- **Window** 180° servo (0° = closed, 180° = open)
- **Curtain** 360° servo (OPEN / STOP / CLOSE)
- **PIR Motion** detection display

### Bedroom
- **LED Light** ON/OFF
- **Fan** ON/OFF
- **AC Simulation** OFF / 70% / 90% / 100%
- **Window** 180° servo (0° = closed, 180° = open)
- **Curtain** 360° servo (OPEN / STOP / CLOSE)
- **PIR Motion** detection display

---

## ⚠️ Important Notes

### Relay Active LOW Logic
All relay modules are **Active LOW**:
- `digitalWrite(pin, LOW)` = Relay **ON** (device powered)
- `digitalWrite(pin, HIGH)` = Relay **OFF** (device unpowered)

The firmware handles this automatically. On startup, all relays initialize to HIGH (OFF state) for safety.

### 360° Servo Control
360° servos use **speed/direction** control, not position:
- `servo.write(0)` = Full speed counter-clockwise (CLOSE)
- `servo.write(90)` = Stop
- `servo.write(180)` = Full speed clockwise (OPEN)

### TLS/MQTT Security
The system uses **MQTT over TLS (port 8883)** for HiveMQ Cloud. The ESP32 uses `wifiClient.setInsecure()` which skips certificate verification. For production, implement proper certificate validation.

### Credentials Security
**NEVER commit `.env` file to Git!** The `.env` file contains sensitive MQTT credentials. Use `.env.example` as a template.

---

## 🧪 Testing Checklist

### Hardware Tests
- [ ] Door lock relay ON/OFF
- [ ] Living LED ON/OFF
- [ ] Living exhaust fan ON/OFF
- [ ] Living AC 70%, 90%, 100%
- [ ] Kitchen LED ON/OFF
- [ ] Kitchen exhaust fan ON/OFF
- [ ] Kitchen window servo 0°, 90°, 180°
- [ ] Kitchen curtain OPEN, STOP, CLOSE
- [ ] Bedroom LED ON/OFF
- [ ] Bedroom fan ON/OFF
- [ ] Bedroom AC 70%, 90%, 100%
- [ ] Bedroom window servo 0°, 90°, 180°
- [ ] Bedroom curtain OPEN, STOP, CLOSE
- [ ] DHT22 temperature/humidity reading
- [ ] PIR living motion detection
- [ ] PIR kitchen motion detection
- [ ] PIR bedroom motion detection
- [ ] AS608 fingerprint detection (if implemented)

### Software Tests
- [ ] WebSocket connection stable
- [ ] MQTT TLS connection stable
- [ ] Frontend receives real-time updates
- [ ] All controls send correct MQTT commands
- [ ] State synchronizes after page refresh
- [ ] Event log displays correctly

---

## 🐛 Troubleshooting

### ESP32 won't connect to MQTT
1. Check WiFi credentials
2. Verify MQTT broker URL and port (8883 for TLS)
3. Verify MQTT username/password
4. Check Serial Monitor for connection errors

### Relays behave inverted
- Verify Active LOW logic is implemented correctly
- Some relay modules may have different logic - adjust in `setRelay()` function

### Servos not moving
- Check power supply (servos need external power for multiple units)
- Verify GPIO pins are correct
- Check servo pulse width settings (500-2400 µs)

### Frontend not updating
1. Check backend is running on port 3000
2. Check WebSocket connection (green dot in header)
3. Check browser console for errors
4. Verify MQTT broker is reachable from backend

---

## 📝 Architecture

```
Browser (Frontend)
    ↕ WebSocket (ws://)
Node.js Backend (server.js)
    ↕ MQTT over TLS (mqtts://8883)
HiveMQ Cloud MQTT Broker
    ↕ MQTT over TLS (mqtts://8883)
ESP32 (smart_home.ino)
    ↕ GPIO
Hardware Devices
```

**Data Flow:**
1. User clicks button in browser
2. WebSocket sends command to backend
3. Backend publishes MQTT message
4. ESP32 receives MQTT message
5. ESP32 controls GPIO pin
6. ESP32 publishes status back to MQTT
7. Backend receives status via MQTT
8. Backend broadcasts to all WebSocket clients
9. Frontend updates UI in real-time

---

## 🔐 Security Recommendations

1. **Change default credentials** in all configuration files
2. **Use strong passwords** for WiFi and MQTT
3. **Enable MQTT ACLs** to restrict topic access
4. **Implement certificate validation** for production TLS
5. **Use HTTPS** for web dashboard in production
6. **Secure backend** behind firewall/reverse proxy
7. **Keep firmware updated** to patch security vulnerabilities

---

## 📚 Future Enhancements

- [ ] AS608 fingerprint authentication implementation
- [ ] Automation rules (time-based, sensor-triggered)
- [ ] Database persistence (device history, logs)
- [ ] Mobile app (React Native / Flutter)
- [ ] Voice control integration (Alexa / Google Home)
- [ ] Energy monitoring
- [ ] Camera integration
- [ ] Multi-user authentication

---

## 📄 License

MIT License - Free to use and modify

---

## 🙏 Credits

Developed as part of the WIN Project - Smart Home IoT System
