require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const mqtt      = require('mqtt');
const path      = require('path');
const session   = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt    = require('bcrypt');
const db        = require('./db');

const app    = express();
const server = http.createServer(app);
// noServer: upgrades are gated by the session check in server.on('upgrade') below
const wss    = new WebSocket.Server({ noServer: true });

const START_TIME = Date.now();

// System Scene IDs
const HOME_SCENE_ID = 2;
const SLEEP_SCENE_ID = 3;
const WAKE_UP_SCENE_ID = 4;
const EXIT_SCENE_ID = 5;

// Sleep Timer State
let activeSleepTimer = null; // { timeoutId, sceneId, endTime }

// Wake Up → Home Timer State
let activeWakeHomeTimer = null; // { timeoutId, sceneId, endTime }

app.use(express.json({ limit: '100kb' }));

// Session middleware for web login
if (!process.env.SESSION_SECRET) {
  console.warn('[AUTH] SESSION_SECRET is not set; using development fallback. Set SESSION_SECRET in .env before any non-local deployment.');
}

// MySQL session store - persistent across restarts, no memory leaks
const sessionStore = new MySQLStore({
  createDatabaseTable: true,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,  // clean up expired sessions every 15 min
  expiration: 24 * 60 * 60 * 1000,          // 24 hours
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data'
    }
  }
}, db.pool);

sessionStore.onReady()
  .then(() => console.log('[AUTH] MySQL session store ready'))
  .catch(err => console.error('[AUTH] Session store error:', err.message));

// Trust Railway reverse proxy for secure cookie handling
app.set('trust proxy', 1);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret-change-in-production',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
});

app.use(sessionMiddleware);

// CORS - frontend hardcode http://localhost:3000 ไว้ ถ้าเปิดหน้าผ่าน Live Server
// (port 5500) จะเป็น cross-origin ใส่ header เองแทนการลง cors package
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, '../frontend')));

const mqttClient = mqtt.connect(process.env.MQTT_BROKER || 'mqtt://localhost:1883', {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  rejectUnauthorized: true
});

/* =====================================================
   TELEGRAM BOT INITIALIZATION
   Initializes only when BOTH credentials are present.
   Gracefully degrades if missing - backend continues normally.
===================================================== */
let telegramBot = null;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID && TELEGRAM_TOKEN.trim() && TELEGRAM_CHAT_ID.trim()) {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    console.log('[TELEGRAM] Bot initialized - Security alerts enabled');
  } catch (err) {
    console.error('[TELEGRAM] Failed to initialize bot:', err.message);
  }
} else {
  console.warn('[TELEGRAM] Bot not configured - Security alerts disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env)');
}

let state = {
  sensor: {
    temp: null,
    hum: null,
    lastUpdate: null
  },
  door: {
    locked: true  // true = locked (relay HIGH), false = unlocked (relay LOW)
  },
  living: {
    led: false,
    exhaustFan: false,
    ac: 0,  // 0=off, 70, 90, 100
    pir: 0
  },
  kitchen: {
    led: false,
    exhaustFan: false,
    window: 0,      // 0-180 degrees
    curtain: 'stop',
    pir: 0
  },
  bedroom: {
    led: false,
    fan: false,
    ac: 0,  // 0=off, 70, 90, 100
    window: 0,      // 0-180 degrees
    curtain: 'stop',
    pir: 0
  },
  fingerprint: {
    lastId: null,
    lastEvent: null
  },
  scene: 'home',
  autoMode: false,
  autoSettings: {
    lightFanTimeout: null,  // วินาที - ค่าจริงจาก ESP32 (home/status/auto/settings) เท่านั้น ไม่ใช่ค่าที่ submit
    acTimeout: null
  },
  mqttOnline: false,
  telegramOnline: false,   // true when Telegram bot initialized (set after init below)
  lastUpdate: null,
  pir: {
    living: false,
    kitchen: false,
    bedroom: false
  }
};

/* =====================================================
   TELEGRAM SECURITY ALERT HELPERS - GLOBAL VARIABLES
   (Must be declared before any loadTelegramSettings() call)
===================================================== */

// Global cooldown timestamp for Telegram alerts
let lastTelegramAlertTime = 0;
let telegramAlertSending = false; // Lock to prevent concurrent sends

// In-memory cache for Telegram settings (loaded from database)
let telegramSettingsCache = {
  telegram_enabled: false,
  telegram_cooldown_value: 5,
  telegram_cooldown_unit: 'seconds',
  alert_motion_enabled: false,
  alert_fingerprint_enabled: false,
  alert_security_enabled: false,
  motion_living_enabled: false,
  motion_kitchen_enabled: false,
  motion_bedroom_enabled: false
};

// Set Telegram status based on initialization result
if (telegramBot) {
  state.telegramOnline = true;
  // Load Telegram settings from database (async, non-blocking)
  loadTelegramSettings().catch(err => {
    console.error('[TELEGRAM] Failed to load settings on startup:', err.message);
    console.warn('[TELEGRAM] Using safe default settings (all disabled)');
  });
}

/* =====================================================
   ROOM CAPABILITIES
   อ้างจาก GPIO mapping ใน README.md - living ไม่มี window/curtain,
   kitchen ไม่มี AC ใช้ตรวจก่อน publish เพื่อไม่ยิง MQTT มั่ว
===================================================== */

const ROOMS = ['living', 'kitchen', 'bedroom'];

const CAPABILITIES = {
  living:  { led: true, fan: true,  ac: true,  window: false, curtain: false },
  kitchen: { led: true, fan: true,  ac: false, window: true,  curtain: true  },
  bedroom: { led: true, fan: true,  ac: true,  window: true,  curtain: true  }
};

// ห้อง living/kitchen ใช้ field ชื่อ exhaustFan, bedroom ใช้ fan
const fanField = room => (room === 'bedroom' ? 'fan' : 'exhaustFan');

// frontend ส่ง level 0-3 แต่ ESP32 รับเป็น duty cycle 0/70/90/100
const AC_LEVELS = [0, 70, 90, 100];
const acLevelToEsp32 = level => AC_LEVELS[level] ?? 0;
const acLevelFromEsp32 = value => {
  const index = AC_LEVELS.indexOf(value);
  return index === -1 ? 0 : index;
};

/* =====================================================
   EVENT LOG (in-memory ring)
===================================================== */

const MAX_LOGS = 100;
let logs = [];

// timer เดียวสำหรับ WAKE-UP mode - ต้องประกาศไว้บนสุดเพราะทั้ง
// cancelWakeupIfUserCommand() (route ผู้ใช้) และ runSceneInternal() (scene
// engine) อ้างถึงตัวแปรเดียวกันนี้
let wakeupTimer = null;

// Auto-lock timer for fingerprint door access
let fingerprintAutoLockTimer = null;
const FINGERPRINT_AUTO_LOCK_DELAY = 5000; // 5 seconds

// Fingerprint security alert tracking
const FINGERPRINT_FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const FINGERPRINT_FAILURE_THRESHOLD = 3; // Alert on 3rd consecutive failure
let fingerprintFailureTracking = {
  count: 0,
  lastFailureTime: null
};

// Admin authorization for fingerprint management
let fingerprintAdminAuthorization = {
  pending: false,
  requestedAt: null,
  authorized: false,
  authorizedUser: null,
  authorizedAt: null,
  expiresAt: null
};

const ADMIN_AUTH_REQUEST_TIMEOUT = 60000; // 60 seconds for scan request
const ADMIN_AUTH_SESSION_DURATION = 300000; // 5 minutes session
let adminAuthTimeoutTimer = null;

// Fingerprint enrollment state
let fingerprintEnrollment = {
  active: false,
  fingerprintId: null,
  name: null,
  role: null,
  startedBy: null,
  startedAt: null
};

const FINGERPRINT_ENROLLMENT_TIMEOUT = 120000; // 2 minutes
let enrollmentTimeoutTimer = null;

// Fingerprint deletion state
let fingerprintDeletion = {
  active: false,
  fingerprintId: null,
  requestedAt: null
};

const FINGERPRINT_DELETION_TIMEOUT = 60000; // 60 seconds
let deletionTimeoutTimer = null;

/* =====================================================
   TELEGRAM SECURITY ALERT HELPERS - FUNCTION DEFINITIONS
===================================================== */

/**
 * Load Telegram settings from database into memory cache
 * Graceful degradation: keeps last known good settings on failure
 */
async function loadTelegramSettings() {
  try {
    // Check database availability
    if (!db.isConnected()) {
      console.warn('[TELEGRAM] Database unavailable - using cached settings');
      return telegramSettingsCache;
    }

    // Query all settings
    const [rows] = await db.pool.execute(
      'SELECT setting_key, setting_value FROM telegram_settings'
    );

    // Build new settings object
    const newSettings = { ...telegramSettingsCache }; // Start with current cache as fallback

    rows.forEach(row => {
      const key = row.setting_key;
      let value = row.setting_value;

      // Convert boolean strings
      if ([
        'telegram_enabled',
        'alert_motion_enabled',
        'alert_fingerprint_enabled',
        'alert_security_enabled',
        'motion_living_enabled',
        'motion_kitchen_enabled',
        'motion_bedroom_enabled'
      ].includes(key)) {
        newSettings[key] = value === 'true';
      }
      // Convert cooldown value to number
      else if (key === 'telegram_cooldown_value') {
        const numValue = Number(value);
        newSettings[key] = (Number.isFinite(numValue) && numValue >= 1) ? numValue : 5;
      }
      // Validate cooldown unit
      else if (key === 'telegram_cooldown_unit') {
        newSettings[key] = (value === 'seconds' || value === 'minutes') ? value : 'seconds';
      }
    });

    // Update cache with successfully loaded settings
    telegramSettingsCache = newSettings;
    console.log('[TELEGRAM] Settings loaded successfully');

    return telegramSettingsCache;
  } catch (err) {
    console.error('[TELEGRAM] Failed to load settings:', err.message);
    console.warn('[TELEGRAM] Using cached settings as fallback');
    return telegramSettingsCache;
  }
}

/**
 * Calculate cooldown in milliseconds from settings
 */
function calculateTelegramCooldownMs(value, unit) {
  // Validate value
  if (!Number.isFinite(value) || value < 1) {
    return 5000; // Default 5 seconds
  }

  // Convert based on unit
  if (unit === 'seconds') {
    return value * 1000;
  } else if (unit === 'minutes') {
    return value * 60 * 1000;
  }

  // Fallback
  return 5000;
}

/**
 * Check if Telegram motion alert should be sent
 * Validates scene mode, global enable, and motion alert enable
 * Only sends alerts during Away Mode or Sleep Mode
 */
function shouldSendTelegramAlert() {
  // Scene mode check (preserve existing security behavior)
  if (state.scene !== 'exit' && state.scene !== 'sleep') {
    return false;
  }

  // Global Telegram enable
  if (!telegramSettingsCache.telegram_enabled) {
    return false;
  }

  // Motion alerts enable
  if (!telegramSettingsCache.alert_motion_enabled) {
    return false;
  }

  return true;
}

/**
 * Send Telegram security alert (non-blocking, graceful failure)
 * @param {string} room - Room where motion was detected
 */
async function sendTelegramAlert(room) {
  if (!telegramBot || !TELEGRAM_CHAT_ID) return;

  // Check room-specific setting
  const roomSettingMap = {
    'living': 'motion_living_enabled',
    'kitchen': 'motion_kitchen_enabled',
    'bedroom': 'motion_bedroom_enabled'
  };

  const roomSettingKey = roomSettingMap[room];

  // Unknown room - fail closed
  if (!roomSettingKey) {
    console.log(`[TELEGRAM] Alert blocked (unknown room): ${room}`);
    return;
  }

  // Check if this specific room is enabled
  if (!telegramSettingsCache[roomSettingKey]) {
    console.log(`[TELEGRAM] Alert blocked (room disabled): ${room}`);
    return;
  }

  // Check if another alert is currently being sent
  if (telegramAlertSending) {
    console.log(`[TELEGRAM] Alert blocked (send already in progress): ${room}`);
    return;
  }

  // Calculate dynamic cooldown from settings
  const cooldownMs = calculateTelegramCooldownMs(
    telegramSettingsCache.telegram_cooldown_value,
    telegramSettingsCache.telegram_cooldown_unit
  );

  // Check cooldown - prevent spam alerts
  const now = Date.now();
  if (now - lastTelegramAlertTime < cooldownMs) {
    console.log(`[TELEGRAM] Alert blocked (cooldown active): ${room}`);
    return;
  }

  // Set sending lock
  telegramAlertSending = true;

  try {
    const modeNames = {
      'exit': 'Away Mode',
      'sleep': 'Sleep Mode'
    };

    const roomInfo = {
      'living': { emoji: '🛋️', name: 'LIVING ROOM' },
      'kitchen': { emoji: '🍳', name: 'KITCHEN' },
      'bedroom': { emoji: '🛏️', name: 'BEDROOM' }
    };

    const modeName = modeNames[state.scene] || state.scene;
    const roomData = roomInfo[room] || { emoji: '🏠', name: room.toUpperCase() };

    const timestamp = new Date().toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(',', ' •');

    const message = `🚨 SECURITY ALERT

${roomData.emoji} ${roomData.name}
━━━━━━━━━━━━━━

⚠️ Motion Detected!

🏠 Mode: ${modeName}
🕒 Time: ${timestamp}

━━━━━━━━━━━━━━
🔒 Automation Living`;

    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message);

    // Update cooldown timestamp ONLY after successful send
    lastTelegramAlertTime = now;

    console.log(`[TELEGRAM] Alert sent: Motion in ${room} during ${modeName}`);
  } catch (err) {
    console.error('[TELEGRAM] Failed to send alert:', err.message);
    // Graceful degradation - don't throw, system continues normally
    // Don't update lastTelegramAlertTime on failure
  } finally {
    // Always release the sending lock
    telegramAlertSending = false;
  }
}

function addLog(type, message, extra = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    type,
    message,
    ...extra
  };

  // Existing: in-memory ring buffer
  logs.unshift(event);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;

  // NEW: MySQL persistence (non-blocking, graceful failure)
  if (db.isConnected()) {
    const normalized = db.normalizeEvent(event);
    db.insertEvent(normalized).catch(err => {
      console.error('[MySQL] Insert failed:', err.message);
      // Don't throw - log error and continue
    });
  }
}

/**
 * Handle fingerprint authentication failure
 * Tracks consecutive failures and sends Telegram alert on 3rd failure within 5 minutes
 */
async function handleFingerprintFailure(failureType, fingerprintId) {
  const now = Date.now();

  // Check if this is within the 5-minute window
  if (fingerprintFailureTracking.lastFailureTime) {
    const timeSinceLastFailure = now - fingerprintFailureTracking.lastFailureTime;

    // If more than 5 minutes passed, start a new sequence
    if (timeSinceLastFailure > FINGERPRINT_FAILURE_WINDOW_MS) {
      console.log('[FINGERPRINT SECURITY] Previous failure was more than 5 minutes ago - starting new sequence');
      fingerprintFailureTracking.count = 0;
    }
  }

  // Increment failure count
  fingerprintFailureTracking.count++;
  fingerprintFailureTracking.lastFailureTime = now;

  console.log(`[FINGERPRINT SECURITY] Consecutive failures: ${fingerprintFailureTracking.count}/${FINGERPRINT_FAILURE_THRESHOLD}`);

  // Check if we've reached the threshold
  if (fingerprintFailureTracking.count >= FINGERPRINT_FAILURE_THRESHOLD) {
    console.log('[FINGERPRINT SECURITY] Threshold reached - sending Telegram alert');

    // Send Telegram alert
    await sendFingerprintSecurityAlert(fingerprintFailureTracking.count);

    // Reset counter after sending alert
    fingerprintFailureTracking.count = 0;
    fingerprintFailureTracking.lastFailureTime = null;

    console.log('[FINGERPRINT SECURITY] Counter reset after alert');
  }
}

/**
 * Send Telegram security alert for consecutive fingerprint failures
 */
async function sendFingerprintSecurityAlert(failureCount) {
  if (!telegramBot || !TELEGRAM_CHAT_ID) {
    console.warn('[FINGERPRINT SECURITY] Telegram not configured - alert not sent');
    return;
  }

  try {
    const timestamp = new Date().toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const message = `🚨 *Fingerprint Security Alert*\n\n` +
      `${failureCount} consecutive fingerprint verification failures detected.\n\n` +
      `📍 Location: Main Door\n` +
      `🔢 Attempts: ${failureCount}\n` +
      `🕐 Time: ${timestamp}\n\n` +
      `⚠️ Please check the door.`;

    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });

    console.log('[FINGERPRINT SECURITY] Telegram alert sent successfully');

    // Log the security alert event
    addLog('security', `🚨 Fingerprint security alert: ${failureCount} consecutive failures`, {
      event_type: 'fingerprint_security_alert',
      failure_count: failureCount,
      alert_sent: true,
      telegram: true
    });

  } catch (err) {
    console.error('[FINGERPRINT SECURITY] Failed to send Telegram alert:', err.message);

    // Log the failure
    addLog('security', `Failed to send fingerprint security alert: ${err.message}`, {
      event_type: 'fingerprint_security_alert',
      failure_count: failureCount,
      alert_sent: false,
      error: err.message
    });
  }
}

/* =====================================================
   STATE PROJECTION
   state ภายในเก็บแบบ nested by room (state.living.led) แต่ frontend
   (updateDeviceStatesFromMQTT ใน script.js) อ่านแบบ grouped by device
   ฟังก์ชันนี้แปลงตอนส่งออกเท่านั้น ไม่แตะ state จริง
===================================================== */

const ESP32_TIMEOUT_MS = 30000;  // firmware publish sensor ทุก 2 วินาที

function isEsp32Online() {
  if (!state.sensor.lastUpdate) return false;
  return Date.now() - new Date(state.sensor.lastUpdate).getTime() < ESP32_TIMEOUT_MS;
}

function projectState() {
  const online = isEsp32Online();

  const projected = {
    door: state.door.locked ? 'locked' : 'unlocked',

    led: {
      living:  state.living.led,
      kitchen: state.kitchen.led,
      bedroom: state.bedroom.led
    },

    fan: {
      living:  state.living.exhaustFan,
      kitchen: state.kitchen.exhaustFan,
      bedroom: state.bedroom.fan
    },

    ac: {
      living:  { level: acLevelFromEsp32(state.living.ac) },
      bedroom: { level: acLevelFromEsp32(state.bedroom.ac) }
    },

    // frontend อ่าน state.servo.window / .curtain เป็นค่าเดียวแล้วเอาไปใส่ทุกห้อง
    // (ข้อจำกัดของ script.js:4717-4722) ค่าต่อห้องที่ถูกต้องจะตามมาทาง
    // mqtt_message ที่ replay ตอนต่อ WS - ดู sendInitialState()
    servo: {
      window:  state.kitchen.window > 90 ? 'open' : 'closed',
      curtain: state.kitchen.curtain === 'open' ? 'open' : 'closed'
    },

    scene: state.scene,

    pir: {
      living:  state.pir.living,
      kitchen: state.pir.kitchen,
      bedroom: state.pir.bedroom
    },

    sensors: {
      pir: {
        living:  !!state.living.pir,
        kitchen: !!state.kitchen.pir,
        bedroom: !!state.bedroom.pir
      }
    },

    system: {
      status: online ? 'online' : 'offline',
      mqtt: state.mqttOnline,
      telegram: state.telegramOnline,
      autoMode: state.autoMode,
      autoSettings: {
        lightFanTimeout: state.autoSettings.lightFanTimeout,
        acTimeout: state.autoSettings.acTimeout
      }
    }
  };

  // ใส่ dht22 เฉพาะเมื่อมีค่าจริงแล้ว - script.js:4446 ส่งค่าเข้า
  // updateSensorData() ซึ่งเรียก temperature.toFixed(1) ทันที ถ้าส่ง null
  // ไปจะ throw แล้วทำให้ initial_state handler ตายก่อนถึง updateSystemStatus()
  if (typeof state.sensor.temp === 'number' && typeof state.sensor.hum === 'number') {
    projected.sensors.dht22 = {
      temperature: state.sensor.temp,
      humidity: state.sensor.hum,
      lastUpdate: state.sensor.lastUpdate,
      // field เปล่าสำหรับ fetchSensorData() ใน script.js:3147 ที่ประกาศ
      // const sensorData ทับ global แล้ว push ลง array - ถ้าไม่มีจะ throw
      temperatureHistory: [],
      humidityHistory: [],
      maxHistorySize: 20,
      chartData: { labels: [], temperatureValues: [], humidityValues: [] }
    };
  }

  return projected;
}

/* =====================================================
   MQTT
===================================================== */

const SUBSCRIBE_TOPICS = [
  'home/sensor/dht22',
  'home/sensor/pir/living',
  'home/sensor/pir/kitchen',
  'home/sensor/pir/bedroom',
  'home/sensor/fingerprint',
  'home/status/door',
  'home/status/living',
  'home/status/kitchen',
  'home/status/bedroom',
  'home/status/mode',
  'home/status/auto/settings',
  'home/status/pir',
  'home/status/fingerprint/enrollment',
  'home/status/fingerprint/deletion',
  'home/debug/log'
];

// เก็บ payload ล่าสุดของแต่ละ topic ไว้ replay ให้ client ที่เพิ่งต่อเข้ามา
const lastPayloads = {};

mqttClient.on('connect', () => {
  console.log('[MQTT] Connected');
  state.mqttOnline = true;
  addLog('system', 'MQTT connected');

  SUBSCRIBE_TOPICS.forEach(topic => mqttClient.subscribe(topic));

  broadcast({ type: 'mqtt_status', connected: true });
});

mqttClient.on('error', e => {
  console.error('[MQTT]', e.message);
  state.mqttOnline = false;
});

mqttClient.on('offline', () => {
  state.mqttOnline = false;
  addLog('system', 'MQTT offline');
  broadcast({ type: 'mqtt_status', connected: false });
});

mqttClient.on('message', (topic, raw) => {
  let data; try { data = JSON.parse(raw.toString()); } catch { return; }

  // ESP32 Automatic Mode debug telemetry - แยกออกจาก state จริงทั้งหมด
  // ไม่เก็บใน state/lastPayloads ไม่ผ่าน addLog/broadcast mqtt_message เดิม
  // ส่งต่อเป็น message type ใหม่ (debug_log) เท่านั้น ไม่กระทบ behavior เดิม
  if (topic === 'home/debug/log') {
    console.log('[ESP32 DEBUG]', data.message);
    broadcast({
      type: 'debug_log',
      data: {
        message: data.message,
        timestamp: data.timestamp
      }
    });
    return;
  }

  state.lastUpdate = new Date().toISOString();
  lastPayloads[topic] = data;

  // Sensors
  if (topic === 'home/sensor/dht22') {
    state.sensor.temp = data.temp;
    state.sensor.hum = data.hum;
    state.sensor.lastUpdate = state.lastUpdate;
  }
  else if (topic === 'home/sensor/pir/living') {
    state.living.pir = data.pir || 0;
    state.pir.living = !!data.pir;
    if (data.pir) {
      addLog('sensor', 'Motion detected in living room', { room: 'living' });
      if (shouldSendTelegramAlert()) {
        sendTelegramAlert('living');
      }
    }
  }
  else if (topic === 'home/sensor/pir/kitchen') {
    state.kitchen.pir = data.pir || 0;
    state.pir.kitchen = !!data.pir;
    if (data.pir) {
      addLog('sensor', 'Motion detected in kitchen', { room: 'kitchen' });
      if (shouldSendTelegramAlert()) {
        sendTelegramAlert('kitchen');
      }
    }
  }
  else if (topic === 'home/sensor/pir/bedroom') {
    state.bedroom.pir = data.pir || 0;
    state.pir.bedroom = !!data.pir;
    if (data.pir) {
      addLog('sensor', 'Motion detected in bedroom', { room: 'bedroom' });
      if (shouldSendTelegramAlert()) {
        sendTelegramAlert('bedroom');
      }
    }
  }
  else if (topic === 'home/sensor/fingerprint') {
    // Handle fingerprint events
    if (data.status === 'success' && data.fingerprintId !== undefined) {
      state.fingerprint.lastId = data.fingerprintId;
      state.fingerprint.lastEvent = 'success';

      console.log('[FINGERPRINT MQTT] Received fingerprint success');
      console.log('[FINGERPRINT MQTT] ID:', data.fingerprintId);
      console.log('[FINGERPRINT MQTT] Confidence:', data.confidence);

      // Lookup fingerprint user in database
      db.getFingerprintUser(data.fingerprintId)
        .then(user => {
          if (user) {
            // Known user found
            console.log('[FINGERPRINT AUTH]');
            console.log('Fingerprint ID:', data.fingerprintId);
            console.log('Name:', user.name);
            console.log('Role:', user.role);
            console.log('Confidence:', data.confidence);

            addLog('security', `Fingerprint authenticated: ${user.name} (${user.role})`, {
              fingerprintId: data.fingerprintId,
              name: user.name,
              role: user.role,
              confidence: data.confidence,
              status: 'success'
            });

            // Reset consecutive failure counter on successful authentication
            fingerprintFailureTracking.count = 0;
            fingerprintFailureTracking.lastFailureTime = null;

            // Check if admin authorization is pending
            if (fingerprintAdminAuthorization.pending) {
              if (user.role === 'ADMIN') {
                // ADMIN fingerprint - grant authorization
                console.log('[FINGERPRINT ADMIN] Authorization granted');

                fingerprintAdminAuthorization.pending = false;
                fingerprintAdminAuthorization.authorized = true;
                fingerprintAdminAuthorization.authorizedUser = {
                  fingerprintId: data.fingerprintId,
                  name: user.name,
                  role: user.role
                };
                fingerprintAdminAuthorization.authorizedAt = new Date().toISOString();
                fingerprintAdminAuthorization.expiresAt = new Date(Date.now() + ADMIN_AUTH_SESSION_DURATION).toISOString();

                // Clear request timeout
                if (adminAuthTimeoutTimer) {
                  clearTimeout(adminAuthTimeoutTimer);
                  adminAuthTimeoutTimer = null;
                }

                // Start session expiration timer
                adminAuthTimeoutTimer = setTimeout(() => {
                  console.log('[FINGERPRINT ADMIN] Session expired');
                  fingerprintAdminAuthorization.authorized = false;
                  fingerprintAdminAuthorization.authorizedUser = null;
                  fingerprintAdminAuthorization.expiresAt = null;
                  adminAuthTimeoutTimer = null;

                  broadcast({
                    type: 'fingerprint_admin_expired',
                    message: 'Admin authorization session expired'
                  });

                  addLog('security', 'Admin authorization session expired');
                }, ADMIN_AUTH_SESSION_DURATION);

                broadcast({
                  type: 'fingerprint_admin_authorized',
                  user: fingerprintAdminAuthorization.authorizedUser,
                  expiresAt: fingerprintAdminAuthorization.expiresAt
                });

                addLog('security', `Admin authorization granted: ${user.name}`, {
                  fingerprintId: data.fingerprintId,
                  name: user.name,
                  action: 'admin_auth_success'
                });
              } else {
                // Non-ADMIN fingerprint - deny authorization
                console.log('[FINGERPRINT ADMIN] Authorization denied - ADMIN role required');

                broadcast({
                  type: 'fingerprint_admin_denied',
                  reason: 'ADMIN fingerprint required',
                  scannedRole: user.role
                });

                addLog('security', `Admin authorization denied: ${user.name} (${user.role})`, {
                  fingerprintId: data.fingerprintId,
                  name: user.name,
                  role: user.role,
                  action: 'admin_auth_denied'
                });
              }
            }

            // Authorization check: ADMIN or USER can unlock door
            if (user.role === 'ADMIN' || user.role === 'USER') {
              console.log('[FINGERPRINT DOOR] Authorized - unlocking door');

              // Unlock door via MQTT
              publish('home/control/door', { locked: false });

              addLog('device_control', `Door unlocked by fingerprint: ${user.name} (${user.role})`, {
                fingerprintId: data.fingerprintId,
                name: user.name,
                role: user.role,
                action: 'unlock',
                source: 'fingerprint'
              });

              // Clear existing auto-lock timer if any
              if (fingerprintAutoLockTimer) {
                clearTimeout(fingerprintAutoLockTimer);
                console.log('[FINGERPRINT DOOR] Previous auto-lock timer cleared');
              }

              // Start auto-lock timer (5 seconds)
              fingerprintAutoLockTimer = setTimeout(() => {
                console.log('[FINGERPRINT DOOR] Auto-lock timer triggered');
                publish('home/control/door', { locked: true });

                addLog('device_control', 'Door automatically locked after fingerprint access', {
                  source: 'fingerprint',
                  action: 'auto_lock',
                  delaySeconds: FINGERPRINT_AUTO_LOCK_DELAY / 1000
                });

                fingerprintAutoLockTimer = null;
              }, FINGERPRINT_AUTO_LOCK_DELAY);

              console.log('[FINGERPRINT DOOR] Auto-lock timer started (5 seconds)');
            } else {
              console.log('[FINGERPRINT DOOR] Unauthorized role - door remains locked');
            }
          } else {
            // Unknown fingerprint
            console.log('[FINGERPRINT AUTH]');
            console.log('Fingerprint ID:', data.fingerprintId);
            console.log('User: UNKNOWN');
            console.log('Role: UNKNOWN');
            console.log('[FINGERPRINT DOOR] Unknown fingerprint - door remains locked');

            // Check if admin authorization is pending
            if (fingerprintAdminAuthorization.pending) {
              console.log('[FINGERPRINT ADMIN] Authorization denied - Unknown fingerprint');

              broadcast({
                type: 'fingerprint_admin_denied',
                reason: 'Unknown fingerprint - not registered in system'
              });

              addLog('security', `Admin authorization denied: Unknown fingerprint ID ${data.fingerprintId}`, {
                fingerprintId: data.fingerprintId,
                action: 'admin_auth_denied_unknown'
              });
            }

            addLog('security', `Unknown fingerprint ID ${data.fingerprintId} detected`, {
              fingerprintId: data.fingerprintId,
              name: 'UNKNOWN',
              role: 'UNKNOWN',
              confidence: data.confidence,
              status: 'unknown'
            });

            // Track consecutive failures for security alert
            handleFingerprintFailure('unknown', data.fingerprintId);
          }
        })
        .catch(err => {
          console.error('[FINGERPRINT AUTH] Database lookup failed:', err.message);
          console.log('[FINGERPRINT DOOR] Database error - door remains locked (FAIL CLOSED)');

          addLog('security', `Fingerprint authentication failed - database unavailable (ID ${data.fingerprintId})`, {
            fingerprintId: data.fingerprintId,
            confidence: data.confidence,
            status: 'failed',
            error: 'database_lookup_failed'
          });
        });
    } else if (data.status === 'failed') {
      state.fingerprint.lastEvent = 'failed';
      console.log('[FINGERPRINT MQTT] Received fingerprint failed');
      addLog('security', 'Fingerprint authentication failed', { status: 'failed' });

      // Track consecutive failures for security alert
      handleFingerprintFailure('failed', null);
    }
  }

  // Status updates from ESP32
  else if (topic === 'home/status/door') {
    if (data.locked !== undefined) state.door.locked = !!data.locked;
  }
  else if (topic === 'home/status/living') {
    if (data.led !== undefined) state.living.led = !!data.led;
    if (data.exhaustFan !== undefined) state.living.exhaustFan = !!data.exhaustFan;
    if (data.ac !== undefined) state.living.ac = data.ac;
  }
  else if (topic === 'home/status/kitchen') {
    if (data.led !== undefined) state.kitchen.led = !!data.led;
    if (data.exhaustFan !== undefined) state.kitchen.exhaustFan = !!data.exhaustFan;
    if (data.window !== undefined) state.kitchen.window = data.window;
    if (data.curtain !== undefined) state.kitchen.curtain = data.curtain;
  }
  else if (topic === 'home/status/bedroom') {
    if (data.led !== undefined) state.bedroom.led = !!data.led;
    if (data.fan !== undefined) state.bedroom.fan = !!data.fan;
    if (data.ac !== undefined) state.bedroom.ac = data.ac;
    if (data.window !== undefined) state.bedroom.window = data.window;
    if (data.curtain !== undefined) state.bedroom.curtain = data.curtain;
  }
  // โหมดจริงจากบอร์ด - ถือเป็น source of truth แทนค่าที่ backend เดาไว้
  // (ผู้ใช้อาจสลับจากอีกแท็บ หรือบอร์ดรีสตาร์ทกลับเป็น manual)
  else if (topic === 'home/status/mode') {
    if (data.mode !== undefined) state.autoMode = data.mode === 'on';
  }
  // ค่า timeout จริงบนบอร์ด - ESP32 คือ source of truth เสมอ
  // backend ไม่ตั้งค่านี้เองจาก POST /api/auto/settings ต้องรอ echo นี้เท่านั้น
  else if (topic === 'home/status/auto/settings') {
    if (data.lightFanTimeout !== undefined) state.autoSettings.lightFanTimeout = data.lightFanTimeout;
    if (data.acTimeout !== undefined) state.autoSettings.acTimeout = data.acTimeout;
  }
  // สถานะ PIR จริงแบบ real-time จากบอร์ด (แยกจาก home/sensor/pir/* เดิม
  // ที่ใช้ทำ log motion เท่านั้น) - เก็บใน state.pir ใหม่โดยเฉพาะ
  else if (topic === 'home/status/pir') {
    if (data.living !== undefined) state.pir.living = !!data.living;
    if (data.kitchen !== undefined) state.pir.kitchen = !!data.kitchen;
    if (data.bedroom !== undefined) state.pir.bedroom = !!data.bedroom;
  }
  else if (topic === 'home/status/fingerprint/enrollment') {
    // Handle fingerprint enrollment status updates from ESP32
    console.log('[FINGERPRINT ENROLLMENT] Status update:', data.status);

    if (!fingerprintEnrollment.active) {
      console.log('[FINGERPRINT ENROLLMENT] No active enrollment - ignoring status');
      return;
    }

    // Broadcast progress to frontend
    broadcast({
      type: 'fingerprint_enrollment_progress',
      status: data.status,
      fingerprintId: data.fingerprintId,
      error: data.error
    });

    // Handle enrollment completion
    if (data.status === 'success') {
      handleEnrollmentSuccess(data.fingerprintId);
    } else if (data.status === 'failed') {
      handleEnrollmentFailure(data.error || 'Unknown error');
    } else if (data.status === 'cancelled') {
      handleEnrollmentCancelled();
    } else if (data.status === 'started') {
      addLog('security', `Fingerprint enrollment started for ID ${data.fingerprintId}`);
    } else if (data.status === 'first_scan_success') {
      addLog('security', `First fingerprint scan captured for ID ${data.fingerprintId}`);
    } else if (data.status === 'second_scan_success') {
      addLog('security', `Second fingerprint scan captured for ID ${data.fingerprintId}`);
    }
  }
  else if (topic === 'home/status/fingerprint/deletion') {
    // Handle fingerprint deletion status updates from ESP32
    console.log('[FINGERPRINT DELETION] Status update:', data.status);

    if (!fingerprintDeletion.active) {
      console.log('[FINGERPRINT DELETION] No active deletion - ignoring status');
      return;
    }

    // Verify fingerprint ID matches
    if (data.fingerprintId !== fingerprintDeletion.fingerprintId) {
      console.error('[FINGERPRINT DELETION] Fingerprint ID mismatch');
      return;
    }

    // Handle deletion completion
    if (data.status === 'success') {
      handleDeletionSuccess(data.fingerprintId);
    } else if (data.status === 'failed') {
      handleDeletionFailure(data.fingerprintId, data.error || 'Unknown error');
    }
  }

  // ส่ง topic จริงต่อให้ frontend - script.js:4465 มี handler แยกตาม topic
  // ครบแล้ว ไม่ต้องแปลงเป็น message type เฉพาะทาง
  broadcast({
    type: 'mqtt_message',
    topic,
    payload: enrichPayload(topic, data),
    timestamp: state.lastUpdate
  });
});

/**
 * เติม field ที่ frontend ต้องการแต่ firmware ไม่ส่ง
 *
 * script.js:4507 เช็ค `payload.exhaustFan !== undefined` ก่อนอัปเดตพัดลม
 * ทุกห้อง แต่ firmware ส่ง field ชื่อ `fan` สำหรับห้องนอน (smart_home.ino:273)
 * ทำให้พัดลมห้องนอนไม่เคยอัปเดต - มิเรอร์ค่าไปเป็น exhaustFan ให้ตรงกับที่
 * frontend รอ (บรรทัด 4510 อ่าน payload.fan ต่อเองอยู่แล้ว)
 */
function enrichPayload(topic, data) {
  if (topic === 'home/status/bedroom' && data.fan !== undefined && data.exhaustFan === undefined) {
    return { ...data, exhaustFan: data.fan };
  }
  return data;
}

/* =====================================================
   FINGERPRINT ENROLLMENT HELPERS
===================================================== */

async function handleEnrollmentSuccess(fingerprintId) {
  try {
    console.log('[FINGERPRINT ENROLLMENT] Success - saving to database');

    // Clear timeout timer
    if (enrollmentTimeoutTimer) {
      clearTimeout(enrollmentTimeoutTimer);
      enrollmentTimeoutTimer = null;
    }

    // Verify enrollment state
    if (!fingerprintEnrollment.active || fingerprintEnrollment.fingerprintId !== fingerprintId) {
      console.error('[FINGERPRINT ENROLLMENT] State mismatch - enrollment not saved');
      addLog('security', `Fingerprint enrollment state mismatch for ID ${fingerprintId}`);
      return;
    }

    // Save to database
    const result = await db.insertFingerprintUser(
      fingerprintEnrollment.fingerprintId,
      fingerprintEnrollment.name,
      fingerprintEnrollment.role
    );

    console.log('[FINGERPRINT ENROLLMENT] Database save successful');

    addLog('security', `Fingerprint enrolled successfully: ${fingerprintEnrollment.name} (${fingerprintEnrollment.role})`, {
      fingerprintId: fingerprintEnrollment.fingerprintId,
      name: fingerprintEnrollment.name,
      role: fingerprintEnrollment.role,
      enrolledBy: fingerprintEnrollment.startedBy
    });

    broadcast({
      type: 'fingerprint_enrollment_success',
      fingerprintId: fingerprintEnrollment.fingerprintId,
      name: fingerprintEnrollment.name,
      role: fingerprintEnrollment.role
    });

    // Clear enrollment state
    fingerprintEnrollment.active = false;
    fingerprintEnrollment.fingerprintId = null;
    fingerprintEnrollment.name = null;
    fingerprintEnrollment.role = null;
    fingerprintEnrollment.startedBy = null;
    fingerprintEnrollment.startedAt = null;

  } catch (err) {
    console.error('[FINGERPRINT ENROLLMENT] Database save failed:', err.message);

    addLog('security', `Fingerprint enrollment database failure for ID ${fingerprintId}`, {
      error: err.message
    });

    broadcast({
      type: 'fingerprint_enrollment_failed',
      error: 'Database save failed - fingerprint stored in sensor but not in database'
    });

    // Note: Fingerprint is already in AS608 sensor but not in database
    // This is a critical state - manual intervention may be required
    console.error('[FINGERPRINT ENROLLMENT] CRITICAL: Fingerprint stored in sensor but not in database');

    // Clear enrollment state
    fingerprintEnrollment.active = false;
    fingerprintEnrollment.fingerprintId = null;
    fingerprintEnrollment.name = null;
    fingerprintEnrollment.role = null;
    fingerprintEnrollment.startedBy = null;
    fingerprintEnrollment.startedAt = null;
  }
}

function handleEnrollmentFailure(error) {
  console.log('[FINGERPRINT ENROLLMENT] Failed:', error);

  // Clear timeout timer
  if (enrollmentTimeoutTimer) {
    clearTimeout(enrollmentTimeoutTimer);
    enrollmentTimeoutTimer = null;
  }

  addLog('security', `Fingerprint enrollment failed: ${error}`, {
    fingerprintId: fingerprintEnrollment.fingerprintId,
    name: fingerprintEnrollment.name,
    error
  });

  broadcast({
    type: 'fingerprint_enrollment_failed',
    error
  });

  // Clear enrollment state
  fingerprintEnrollment.active = false;
  fingerprintEnrollment.fingerprintId = null;
  fingerprintEnrollment.name = null;
  fingerprintEnrollment.role = null;
  fingerprintEnrollment.startedBy = null;
  fingerprintEnrollment.startedAt = null;
}

function handleEnrollmentCancelled() {
  console.log('[FINGERPRINT ENROLLMENT] Cancelled');

  // Clear timeout timer
  if (enrollmentTimeoutTimer) {
    clearTimeout(enrollmentTimeoutTimer);
    enrollmentTimeoutTimer = null;
  }

  addLog('security', 'Fingerprint enrollment cancelled', {
    fingerprintId: fingerprintEnrollment.fingerprintId,
    name: fingerprintEnrollment.name
  });

  broadcast({
    type: 'fingerprint_enrollment_cancelled'
  });

  // Clear enrollment state
  fingerprintEnrollment.active = false;
  fingerprintEnrollment.fingerprintId = null;
  fingerprintEnrollment.name = null;
  fingerprintEnrollment.role = null;
  fingerprintEnrollment.startedBy = null;
  fingerprintEnrollment.startedAt = null;
}

/* =====================================================
   FINGERPRINT DELETION HELPERS
===================================================== */

async function handleDeletionSuccess(fingerprintId) {
  try {
    console.log('[FINGERPRINT DELETION] Success - deleting from database');

    // Clear timeout timer
    if (deletionTimeoutTimer) {
      clearTimeout(deletionTimeoutTimer);
      deletionTimeoutTimer = null;
    }

    // Verify deletion state
    if (!fingerprintDeletion.active || fingerprintDeletion.fingerprintId !== fingerprintId) {
      console.error('[FINGERPRINT DELETION] State mismatch');
      return;
    }

    // Get user info before deletion for logging
    const user = await db.getFingerprintUser(fingerprintId);
    if (!user) {
      console.error('[FINGERPRINT DELETION] User not found in database');
      addLog('security', `Fingerprint deletion completed but user not found in database: ID ${fingerprintId}`);

      broadcast({
        type: 'fingerprint_deletion_failed',
        fingerprintId,
        error: 'User not found in database'
      });

      // Clear deletion state
      fingerprintDeletion.active = false;
      fingerprintDeletion.fingerprintId = null;
      fingerprintDeletion.requestedAt = null;
      return;
    }

    // Delete from database
    await db.deleteFingerprintUser(fingerprintId);

    // Verify deletion
    const verifyDeleted = await db.getFingerprintUser(fingerprintId);
    if (verifyDeleted) {
      console.error('[FINGERPRINT DELETION] Database deletion verification failed');
      addLog('security', `Fingerprint deletion verification failed: ID ${fingerprintId}`);

      broadcast({
        type: 'fingerprint_deletion_failed',
        fingerprintId,
        error: 'Database deletion verification failed'
      });

      // Clear deletion state
      fingerprintDeletion.active = false;
      fingerprintDeletion.fingerprintId = null;
      fingerprintDeletion.requestedAt = null;
      return;
    }

    console.log('[FINGERPRINT DELETION] Database deletion verified');

    addLog('security', `Fingerprint deleted: ${user.name} (${user.role}) - ID ${fingerprintId}`, {
      fingerprintId,
      name: user.name,
      role: user.role
    });

    broadcast({
      type: 'fingerprint_deletion_success',
      fingerprintId,
      name: user.name
    });

    // Clear deletion state
    fingerprintDeletion.active = false;
    fingerprintDeletion.fingerprintId = null;
    fingerprintDeletion.requestedAt = null;

  } catch (err) {
    console.error('[FINGERPRINT DELETION] Database deletion failed:', err.message);

    addLog('security', `Fingerprint deletion database failure for ID ${fingerprintId}`, {
      error: err.message
    });

    broadcast({
      type: 'fingerprint_deletion_failed',
      fingerprintId,
      error: 'Database deletion failed - fingerprint removed from sensor but not from database'
    });

    console.error('[FINGERPRINT DELETION] CRITICAL: Fingerprint removed from sensor but not from database');

    // Clear deletion state
    fingerprintDeletion.active = false;
    fingerprintDeletion.fingerprintId = null;
    fingerprintDeletion.requestedAt = null;
  }
}

function handleDeletionFailure(fingerprintId, error) {
  console.log('[FINGERPRINT DELETION] Failed:', error);

  // Clear timeout timer
  if (deletionTimeoutTimer) {
    clearTimeout(deletionTimeoutTimer);
    deletionTimeoutTimer = null;
  }

  addLog('security', `Fingerprint deletion failed: ${error}`, {
    fingerprintId,
    error
  });

  broadcast({
    type: 'fingerprint_deletion_failed',
    fingerprintId,
    error
  });

  // Clear deletion state
  fingerprintDeletion.active = false;
  fingerprintDeletion.fingerprintId = null;
  fingerprintDeletion.requestedAt = null;
}

/**
 * publish พร้อมเช็ค connection - คืน error message ถ้าส่งไม่ได้
 */
function publish(topic, payload) {
  if (!mqttClient.connected) return 'MQTT not connected';
  mqttClient.publish(topic, JSON.stringify(payload));
  console.log('[MQTT] ->', topic, JSON.stringify(payload));
  return null;
}

/* =====================================================
   WEBSOCKET
===================================================== */

function sendInitialState(ws) {
  ws.send(JSON.stringify({
    type: 'initial_state',
    state: projectState(),
    logs
  }));

  // replay payload ล่าสุดของแต่ละ topic เป็น mqtt_message เพื่อให้ handler
  // per-room ใน script.js ตั้งค่าแต่ละห้องได้ถูกต้อง (projectState ยุบ
  // servo เป็นค่าเดียวทุกห้องตามที่ frontend อ่าน)
  Object.keys(lastPayloads).forEach(topic => {
    ws.send(JSON.stringify({
      type: 'mqtt_message',
      topic,
      payload: enrichPayload(topic, lastPayloads[topic]),
      timestamp: state.lastUpdate
    }));
  });
}

// WebSocket authentication gate - validate session before accepting connection
server.on('upgrade', (request, socket, head) => {
  console.log('[WS] Upgrade request received');

  // Parse session from request
  sessionMiddleware(request, {}, () => {
    if (request.session && request.session.userId) {
      // Authenticated - allow WebSocket upgrade
      console.log('[WS] Session authenticated, upgrading connection');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      // Unauthenticated - reject
      console.log('[WS] Unauthenticated upgrade rejected');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });
});

wss.on('connection', ws => {
  console.log('[WS] +1 client, total:', wss.clients.size);
  sendInitialState(ws);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // Door control
    if (msg.type === 'door') {
      publish('home/control/door', { locked: msg.locked });
      addLog('device_control', `Door ${msg.locked ? 'locked' : 'unlocked'}`, {
        device: 'door',
        action: msg.locked ? 'lock' : 'unlock',
        source: 'manual'
      });
    }
    // Living room controls
    else if (msg.type === 'living_led') {
      publish('home/control/living/led', { state: msg.state });
      addLog('device_control', `Living room LED ${msg.state ? 'ON' : 'OFF'}`, {
        room: 'living',
        device: 'led',
        state: msg.state,
        source: 'manual'
      });
    }
    else if (msg.type === 'living_fan') {
      publish('home/control/living/fan', { state: msg.state });
      addLog('device_control', `Living room fan ${msg.state ? 'ON' : 'OFF'}`, {
        room: 'living',
        device: 'fan',
        state: msg.state,
        source: 'manual'
      });
    }
    else if (msg.type === 'living_ac') {
      publish('home/control/living/ac', { level: msg.level });
      const acLevel = ['OFF', 'LOW', 'MEDIUM', 'HIGH'][msg.level] || 'UNKNOWN';
      addLog('device_control', `Living room AC set to ${acLevel}`, {
        room: 'living',
        device: 'ac',
        level: msg.level,
        levelName: acLevel,
        source: 'manual'
      });
    }
    // Kitchen controls
    else if (msg.type === 'kitchen_led') {
      publish('home/control/kitchen/led', { state: msg.state });
      addLog('device_control', `Kitchen LED ${msg.state ? 'ON' : 'OFF'}`, {
        room: 'kitchen',
        device: 'led',
        state: msg.state,
        source: 'manual'
      });
    }
    else if (msg.type === 'kitchen_fan') {
      publish('home/control/kitchen/fan', { state: msg.state });
      addLog('device_control', `Kitchen fan ${msg.state ? 'ON' : 'OFF'}`, {
        room: 'kitchen',
        device: 'fan',
        state: msg.state,
        source: 'manual'
      });
    }
    else if (msg.type === 'kitchen_window') {
      publish('home/control/kitchen/window', { angle: msg.angle });
      addLog('device_control', `Kitchen window set to ${msg.angle}°`, {
        room: 'kitchen',
        device: 'window',
        angle: msg.angle,
        source: 'manual'
      });
    }
    else if (msg.type === 'kitchen_curtain') {
      publish('home/control/kitchen/curtain', { action: msg.action });
      addLog('device_control', `Kitchen curtain ${msg.action}`, {
        room: 'kitchen',
        device: 'curtain',
        action: msg.action,
        source: 'manual'
      });
    }
    // Bedroom controls
    else if (msg.type === 'bedroom_led') {
      publish('home/control/bedroom/led', { state: msg.state });
      addLog('device_control', `Bedroom LED ${msg.state ? 'ON' : 'OFF'}`, {
        room: 'bedroom',
        device: 'led',
        state: msg.state,
        source: 'manual'
      });
    }
    else if (msg.type === 'bedroom_fan') {
      publish('home/control/bedroom/fan', { state: msg.state });
      addLog('device_control', `Bedroom fan ${msg.state ? 'ON' : 'OFF'}`, {
        room: 'bedroom',
        device: 'fan',
        state: msg.state,
        source: 'manual'
      });
    }
    else if (msg.type === 'bedroom_ac') {
      publish('home/control/bedroom/ac', { level: msg.level });
      const acLevel = ['OFF', 'LOW', 'MEDIUM', 'HIGH'][msg.level] || 'UNKNOWN';
      addLog('device_control', `Bedroom AC set to ${acLevel}`, {
        room: 'bedroom',
        device: 'ac',
        level: msg.level,
        levelName: acLevel,
        source: 'manual'
      });
    }
    else if (msg.type === 'bedroom_window') {
      publish('home/control/bedroom/window', { angle: msg.angle });
      addLog('device_control', `Bedroom window set to ${msg.angle}°`, {
        room: 'bedroom',
        device: 'window',
        angle: msg.angle,
        source: 'manual'
      });
    }
    else if (msg.type === 'bedroom_curtain') {
      publish('home/control/bedroom/curtain', { action: msg.action });
      addLog('device_control', `Bedroom curtain ${msg.action}`, {
        room: 'bedroom',
        device: 'curtain',
        action: msg.action,
        source: 'manual'
      });
    }
  });

  ws.on('close', () => console.log('[WS] -1 client, total:', wss.clients.size));
});

function broadcast(data) {
  const m = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(m); });
}

/* =====================================================
   REST API
===================================================== */

const ok   = res => res.json({ success: true });
const fail = (res, code, error) => res.status(code).json({ success: false, error });

/**
 * ตรวจว่าห้องมีอยู่และรองรับอุปกรณ์นั้น - คืนข้อความ error ถ้าไม่ผ่าน
 */
function checkRoom(room, device) {
  if (!ROOMS.includes(room)) return `Unknown room: ${room}`;
  if (!CAPABILITIES[room][device]) return `Room ${room} has no ${device}`;
  return null;
}

/**
 * publish แล้วตอบ - รวม error handling ที่ทุก route ใช้เหมือนกัน
 */
function sendCommand(res, topic, payload, logMessage) {
  const error = publish(topic, payload);
  if (error) return fail(res, 503, error);
  addLog('device_control', logMessage, { source: 'web' });
  return ok(res);
}

// ---------- Read ----------

app.get('/api/state', requireWebAuth, (req, res) => res.json({ success: true, state: projectState() }));

app.get('/api/logs', requireWebAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, MAX_LOGS);
  res.json({ success: true, logs: logs.slice(0, limit) });
});

app.get('/api/sensors/latest', requireWebAuth, (req, res) => {
  res.json({ success: true, sensors: projectState().sensors });
});

app.get('/api/system/status', requireWebAuth, (req, res) => {
  const online = isEsp32Online();
  res.json({
    success: true,
    mqtt: { connected: state.mqttOnline, broker: process.env.MQTT_BROKER },
    esp32: { status: online ? 'online' : 'offline', lastSeen: state.sensor.lastUpdate },
    mysql: { connected: db.isConnected() },
    telegram: { connected: state.telegramOnline },
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: state.mqttOnline ? 'ok' : 'degraded',
    mqtt: { connected: state.mqttOnline },
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    timestamp: new Date().toISOString()
  });
});

// ---------- Device control ----------

// คำสั่งจาก user จริงระหว่าง WAKE-UP mode ต้องยกเลิก wake-up timer และกลับไป
// MANUAL - ต่างจาก scene engine ที่เรียก publish() ตรงๆ ไม่ผ่าน route พวกนี้
// เลย จึงไม่ trigger การยกเลิกนี้โดยไม่ตั้งใจ (ดู runSceneInternal ด้านล่าง)
function cancelWakeupIfUserCommand() {
  if (state.scene === 'wake') {
    clearTimeout(wakeupTimer);
    wakeupTimer = null;
    state.scene = 'manual';
    broadcast({ type: 'scene_changed', scene: state.scene });
  }
}

app.post('/api/led/:room/:state', requireWebAuth, (req, res) => {
  const { room, state: value } = req.params;

  const error = checkRoom(room, 'led');
  if (error) return fail(res, 400, error);
  if (value !== 'on' && value !== 'off') return fail(res, 400, `Invalid state: ${value}`);

  cancelWakeupIfUserCommand();
  sendCommand(res, `home/control/${room}/led`, { state: value === 'on' },
    `${room} LED ${value.toUpperCase()}`);
});

app.post('/api/fan/:room/:state', requireWebAuth, (req, res) => {
  const { room, state: value } = req.params;

  const error = checkRoom(room, 'fan');
  if (error) return fail(res, 400, error);
  if (value !== 'on' && value !== 'off') return fail(res, 400, `Invalid state: ${value}`);

  cancelWakeupIfUserCommand();
  sendCommand(res, `home/control/${room}/fan`, { state: value === 'on' },
    `${room} fan ${value.toUpperCase()}`);
});

app.post('/api/ac/:room/:level', requireWebAuth, (req, res) => {
  const { room } = req.params;
  const level = Number(req.params.level);

  const error = checkRoom(room, 'ac');
  if (error) return fail(res, 400, error);
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    return fail(res, 400, `Invalid level: ${req.params.level} (expected 0-3)`);
  }

  cancelWakeupIfUserCommand();
  sendCommand(res, `home/control/${room}/ac`, { level: acLevelToEsp32(level) },
    `${room} AC level ${level}`);
});

app.post('/api/servo/:device/:action', requireWebAuth, (req, res) => {
  // frontend ส่ง device เป็น {type}_{room} เช่น window_kitchen (script.js:2717)
  const [type, room] = req.params.device.split('_');

  // ปุ่ม CLOSE ใน script.js:1784 ส่ง "closed" ไม่ใช่ "close" - รับทั้งสองแบบ
  const action = req.params.action === 'closed' ? 'close' : req.params.action;

  if (type !== 'window' && type !== 'curtain') {
    return fail(res, 400, `Invalid servo type: ${type} (expected window or curtain)`);
  }
  if (action !== 'open' && action !== 'close' && action !== 'stop') {
    return fail(res, 400, `Invalid action: ${req.params.action}`);
  }

  const error = checkRoom(room, type);
  if (error) return fail(res, 400, error);

  // window เป็น servo 180 องศาสั่งด้วย angle, curtain เป็น 360 องศาสั่งด้วย action
  // ESP32 bedroom window mapping (physical servo orientation reversed):
  // OPEN → angle 130 → servo.write(0) → physically OPEN
  // CLOSE → angle 0 → servo.write(130) → physically CLOSE
  const payload = type === 'window'
    ? { angle: action === 'open' ? 90 : 0 }
    : { action };

  cancelWakeupIfUserCommand();
  sendCommand(res, `home/control/${room}/${type}`, payload,
    `${room} ${type} ${action.toUpperCase()}`);
});

app.post('/api/door/:command', requireWebAuth, (req, res) => {
  const { command } = req.params;
  if (command !== 'lock' && command !== 'unlock') {
    return fail(res, 400, `Invalid command: ${command} (expected lock or unlock)`);
  }

  // Cancel fingerprint auto-lock timer if active
  if (fingerprintAutoLockTimer) {
    clearTimeout(fingerprintAutoLockTimer);
    fingerprintAutoLockTimer = null;
    console.log('[DOOR] Fingerprint auto-lock cancelled by manual control');
  }

  sendCommand(res, 'home/control/door', { locked: command === 'lock' },
    `Door ${command.toUpperCase()}`);
});

// ---------- Scene / automation ----------
// scene engine เรียก publish() ตรงๆ (ไม่ผ่าน /api/led, /api/fan, ... ) จึงไม่
// trigger cancelWakeupIfUserCommand() โดยไม่ตั้งใจ - เป็นตัวแยก "user สั่งเอง"
// ออกจาก "scene สั่งเอง" ตามที่ต้องการ

// frontend ส่งชื่อ scene ตัวใหญ่ (script.js:3371-3377) แต่ตัว scene card
// ในหน้าเว็บใช้ id คนละชื่อ - เก็บ id ฝั่ง frontend ไว้ใน state เพื่อให้
// activeScene ที่อ่านจาก initial_state ไป highlight การ์ดได้ถูกใบ
const SCENES = {
  home:      'home',
  away:      'exit',
  sleep:     'sleep',
  wakeup:    'wake',
  manual:    'manual',
  automatic: 'automatic'
};

function runSceneInternal(mode) {
  if (mode === 'home') {
    publish('home/control/living/led', { state: true });
    publish('home/control/kitchen/led', { state: true });
    publish('home/control/living/fan', { state: true });
    setAutoMode(true);
  }
  else if (mode === 'exit') {
    publish('home/control/living/led', { state: false });
    publish('home/control/kitchen/led', { state: false });
    publish('home/control/bedroom/led', { state: false });
    publish('home/control/kitchen/window', { angle: 0 });
    publish('home/control/bedroom/window', { angle: 0 });
    publish('home/control/living/fan', { state: false });
    publish('home/control/kitchen/fan', { state: false });
    publish('home/control/bedroom/fan', { state: false });
    publish('home/control/bedroom/ac', { level: acLevelToEsp32(0) });
    publish('home/control/living/ac', { level: acLevelToEsp32(0) });
    setAutoMode(false);
  }
  else if (mode === 'sleep') {
    publish('home/control/living/led', { state: false });
    publish('home/control/kitchen/led', { state: false });
    publish('home/control/bedroom/led', { state: false });
    publish('home/control/kitchen/window', { angle: 0 });
    publish('home/control/bedroom/window', { angle: 0 });
    publish('home/control/bedroom/ac', { level: acLevelToEsp32(1) }); // existing SLEEP level
    publish('home/control/living/fan', { state: false });
    publish('home/control/kitchen/fan', { state: false });
    setAutoMode(false);
  }
  else if (mode === 'wake') {
    // LEGACY WAKE UP - Redirect to new database-driven system
    // Uses Scene 4 configuration and wake_home_timer from database
    runSceneFromDB(WAKE_UP_SCENE_ID).then(result => {
      if (result.success) {
        console.log('[Legacy Wake Up] Redirected to database-driven Wake Up scene');
      } else {
        console.error('[Legacy Wake Up] Failed to execute database-driven Wake Up');
      }
    }).catch(err => {
      console.error('[Legacy Wake Up] Error redirecting to database Wake Up:', err.message);
    });
    return; // Exit early - database system handles everything
  }
  else if (mode === 'manual') {
    setAutoMode(false);
  }
  else if (mode === 'automatic') {
    setAutoMode(true);
  }
}

/**
 * Execute a scene by reading actions from the database
 * @param {number} sceneId - Database scene ID
 * @returns {Promise<{success: boolean, notFound?: boolean}>}
 */
async function runSceneFromDB(sceneId) {
  try {
    // Fetch scene and its actions from database
    const [scenes] = await db.pool.query(
      'SELECT id, name, is_system FROM scenes WHERE id = ?',
      [sceneId]
    );

    if (scenes.length === 0) {
      console.error(`[Scene Execution] Scene ${sceneId} not found`);
      return { success: false, notFound: true };
    }

    const scene = scenes[0];

    const [actions] = await db.pool.query(
      'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = ? ORDER BY execution_order',
      [sceneId]
    );

    console.log(`[Scene Execution] Running scene ${sceneId} - ${scene.name} with ${actions.length} actions`);

    // Execute each action in order
    for (const action of actions) {
      const { device_type, room, action_type, action_value } = action;

      // Handle auto_mode specially - uses existing setAutoMode() function
      if (device_type === 'auto_mode') {
        const autoModeOn = action_value === 'on' || action_value === true || action_value === 'true';
        setAutoMode(autoModeOn);
        console.log(`[Scene Execution] Auto mode: ${autoModeOn}`);
        continue;
      }

      // Build payload based on action_type
      let payload = {};
      let topic;

      if (action_type === 'state') {
        // Boolean state (led, fan, door)
        const stateValue = action_value === true || action_value === 'true' || action_value === 1 || action_value === '1';
        payload = { state: stateValue };
        topic = `home/control/${room}/${device_type}`;
      } else if (action_type === 'level') {
        // Numeric level (ac) - use existing acLevelToEsp32 conversion
        const levelValue = parseInt(action_value, 10);
        if (device_type === 'ac') {
          payload = { level: acLevelToEsp32(levelValue) };
        } else {
          payload = { level: levelValue };
        }
        topic = `home/control/${room}/${device_type}`;
      } else if (action_type === 'angle') {
        // Angle (window)
        const angleValue = parseInt(action_value, 10);
        payload = { angle: angleValue };
        topic = `home/control/${room}/${device_type}`;
      } else if (action_type === 'mode') {
        // Mode (door: unlock/lock)
        if (device_type === 'door') {
          // Door uses 'locked' field: unlock = false, lock = true
          // Door is NOT room-based - uses home/control/door
          const lockedValue = action_value === 'lock';
          payload = { locked: lockedValue };
          topic = 'home/control/door';
        } else {
          console.warn(`[Scene Execution] Unhandled mode for device_type: ${device_type}`);
          continue;
        }
      } else {
        console.warn(`[Scene Execution] Unknown action_type: ${action_type} for device: ${device_type}`);
        continue;
      }

      // Publish to MQTT using existing publish function
      publish(topic, payload);
      console.log(`[Scene Execution] ${topic} =>`, JSON.stringify(payload));
    }

    // Update scene state and broadcast to all clients
    // Map scene IDs to scene names for projectState
    const sceneNames = {
      2: 'home',
      3: 'sleep',
      4: 'wakeup',
      5: 'exit'
    };

    const sceneName = sceneNames[sceneId] || scene.name.toLowerCase().replace(/\s+/g, '');
    state.scene = sceneName;
    broadcast({ type: 'scene_changed', scene: sceneName });

    return { success: true };

  } catch (error) {
    console.error('[Scene Execution] Error executing scene from DB:', error.message);
    return { success: false, notFound: false };
  }
}

/**
 * Cancel the active sleep timer if one exists
 */
function cancelSleepTimer() {
  if (activeSleepTimer) {
    clearTimeout(activeSleepTimer.timeoutId);
    console.log('[Sleep Timer] Cancelled active timer for scene', activeSleepTimer.sceneId);
    activeSleepTimer = null;

    // Broadcast timer cancellation to all connected clients
    broadcast({ type: 'sleep_timer_cancelled' });
  }
}

/**
 * Start a sleep timer that will execute Wake Up scene after the specified duration
 * @param {number} sceneId - The scene ID that initiated the timer (for logging)
 * @param {number} minutes - Duration in minutes
 * @param {number} seconds - Duration in seconds (0-59)
 */
async function startSleepTimer(sceneId, minutes, seconds) {
  // Cancel any existing timer first
  cancelSleepTimer();

  // Defensive validation
  if (typeof minutes !== 'number' || typeof seconds !== 'number') {
    console.error('[Sleep Timer] Invalid timer values: minutes and seconds must be numbers');
    return;
  }

  if (minutes < 0) {
    console.error('[Sleep Timer] Invalid timer: minutes must be non-negative');
    return;
  }

  if (seconds < 0 || seconds > 59) {
    console.error('[Sleep Timer] Invalid timer: seconds must be between 0 and 59');
    return;
  }

  const totalMilliseconds = (minutes * 60 + seconds) * 1000;

  if (totalMilliseconds <= 0) {
    console.log('[Sleep Timer] Timer duration is 0, not starting timer');
    return;
  }

  const endTime = Date.now() + totalMilliseconds;

  console.log(`[Sleep Timer] Starting ${minutes}m ${seconds}s timer (scene ${sceneId})`);

  const timeoutId = setTimeout(async () => {
    console.log('[Sleep Timer] Timer expired, executing Wake Up scene');

    // Verify this is still the active timer (prevent race conditions)
    if (activeSleepTimer && activeSleepTimer.timeoutId === timeoutId) {
      activeSleepTimer = null;

      // Execute Wake Up scene
      const result = await runSceneFromDB(WAKE_UP_SCENE_ID);

      if (result.success) {
        console.log('[Sleep Timer] Wake Up scene executed successfully');
        broadcast({ type: 'sleep_timer_completed', success: true });

        // After successful Wake Up execution, check if Wake Up → Home timer is configured
        try {
          const [wakeUpScene] = await db.pool.query(
            'SELECT wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = ?',
            [WAKE_UP_SCENE_ID]
          );

          if (wakeUpScene.length > 0) {
            const { wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds } = wakeUpScene[0];

            if (wake_home_timer_enabled && (wake_home_timer_minutes > 0 || wake_home_timer_seconds > 0)) {
              console.log(`[Sleep Timer] Starting Wake→Home timer: ${wake_home_timer_minutes}m ${wake_home_timer_seconds}s`);
              await startWakeHomeTimer(WAKE_UP_SCENE_ID, wake_home_timer_minutes, wake_home_timer_seconds);
            } else {
              console.log('[Sleep Timer] Wake→Home timer not enabled or duration is 0');
            }
          }
        } catch (error) {
          console.error('[Sleep Timer] Error reading Wake→Home timer configuration:', error.message);
        }
      } else {
        console.error('[Sleep Timer] Wake Up scene execution failed');
        broadcast({ type: 'sleep_timer_completed', success: false });
      }
    }
  }, totalMilliseconds);

  activeSleepTimer = {
    timeoutId,
    sceneId,
    endTime
  };

  // Broadcast timer started to all connected clients
  broadcast({
    type: 'sleep_timer_started',
    minutes,
    seconds,
    endTime
  });

  console.log('[Sleep Timer] Timer active, will expire at', new Date(endTime).toISOString());
}

/**
 * Get current sleep timer status
 * @returns {object|null} Timer status or null if no active timer
 */
function getSleepTimerStatus() {
  if (!activeSleepTimer) {
    return null;
  }

  const remainingMs = activeSleepTimer.endTime - Date.now();

  if (remainingMs <= 0) {
    return null;
  }

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return {
    active: true,
    sceneId: activeSleepTimer.sceneId,
    endTime: activeSleepTimer.endTime,
    remainingMinutes: minutes,
    remainingSeconds: seconds
  };
}

/**
 * Cancel the active Wake Up → Home timer if one exists
 */
function cancelWakeHomeTimer() {
  if (activeWakeHomeTimer) {
    clearTimeout(activeWakeHomeTimer.timeoutId);
    console.log('[Wake→Home Timer] Cancelled active timer for scene', activeWakeHomeTimer.sceneId);
    activeWakeHomeTimer = null;

    // Broadcast timer cancellation to all connected clients
    broadcast({ type: 'wake_home_timer_cancelled' });
  }
}

/**
 * Start Wake Up → Home timer that will execute Home scene after the specified duration
 * @param {number} sceneId - The scene ID that initiated the timer (for logging)
 * @param {number} minutes - Duration in minutes
 * @param {number} seconds - Duration in seconds (0-59)
 */
async function startWakeHomeTimer(sceneId, minutes, seconds) {
  // Cancel any existing timer first
  cancelWakeHomeTimer();

  // Defensive validation
  if (typeof minutes !== 'number' || typeof seconds !== 'number') {
    console.error('[Wake→Home Timer] Invalid timer values: minutes and seconds must be numbers');
    return;
  }

  if (minutes < 0) {
    console.error('[Wake→Home Timer] Invalid timer: minutes must be non-negative');
    return;
  }

  if (seconds < 0 || seconds > 59) {
    console.error('[Wake→Home Timer] Invalid timer: seconds must be between 0 and 59');
    return;
  }

  const totalMilliseconds = (minutes * 60 + seconds) * 1000;

  if (totalMilliseconds <= 0) {
    console.log('[Wake→Home Timer] Timer duration is 0, not starting timer');
    return;
  }

  const endTime = Date.now() + totalMilliseconds;

  console.log(`[Wake→Home Timer] Starting ${minutes}m ${seconds}s timer (total: ${totalMilliseconds}ms) for scene ${sceneId}`);

  const timeoutId = setTimeout(async () => {
    // Verify this timeout still belongs to the current active timer
    if (activeWakeHomeTimer && activeWakeHomeTimer.timeoutId === timeoutId) {
      activeWakeHomeTimer = null;
      console.log('[Wake→Home Timer] Timer expired, terminating Wake Up mode');

      // Wake Up termination: close window, turn off fan and LED
      publish('home/control/bedroom/window', { angle: 0 });
      publish('home/control/bedroom/fan', { state: false });
      publish('home/control/bedroom/led', { state: false });
      console.log('[Wake→Home Timer] Wake Up cleanup complete (window=0, fan=OFF, LED=OFF)');

      // Enable Auto Mode after Wake Up cleanup, before Home scene
      // This prepares ESP32 for Home Mode automatic behavior
      setAutoMode(true);
      console.log('[Wake→Home Timer] Auto Mode enabled after Wake Up termination');

      // Now execute Home scene after Wake Up termination is complete
      const result = await runSceneFromDB(HOME_SCENE_ID);

      if (result.success) {
        console.log('[Wake→Home Timer] Home scene executed successfully');
        broadcast({ type: 'wake_home_timer_completed', success: true });
      } else {
        console.error('[Wake→Home Timer] Home scene execution failed');
        broadcast({ type: 'wake_home_timer_completed', success: false });
      }
    }
  }, totalMilliseconds);

  activeWakeHomeTimer = {
    timeoutId,
    sceneId,
    endTime
  };

  // Broadcast timer started to all connected clients
  broadcast({
    type: 'wake_home_timer_started',
    minutes,
    seconds,
    endTime
  });

  console.log('[Wake→Home Timer] Timer active, will expire at', new Date(endTime).toISOString());
}

/**
 * Get current Wake Up → Home timer status
 * @returns {object|null} Timer status or null if no active timer
 */
function getWakeHomeTimerStatus() {
  if (!activeWakeHomeTimer) {
    return null;
  }

  const remainingMs = activeWakeHomeTimer.endTime - Date.now();

  if (remainingMs <= 0) {
    return null;
  }

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return {
    active: true,
    sceneId: activeWakeHomeTimer.sceneId,
    endTime: activeWakeHomeTimer.endTime,
    remainingMinutes: minutes,
    remainingSeconds: seconds
  };
}

app.post('/api/scene/:scene', requireWebAuth, (req, res) => {
  const scene = req.params.scene.toLowerCase();
  if (!SCENES[scene]) {
    return fail(res, 400, `Unknown scene: ${req.params.scene}`);
  }

  // Cancel any active sleep timer when switching scenes
  cancelSleepTimer();

  // เปลี่ยน scene ใหม่ (ไม่ใช่ wake-up timer เดิม auto-activate HOME) ต้องเคลียร์
  // wake-up timer เก่าเสมอ กัน timer เก่ายิงซ้อนถ้า user สั่ง scene อื่นระหว่างรอ
  if (scene !== 'wakeup') {
    clearTimeout(wakeupTimer);
    wakeupTimer = null;
  }

  state.scene = SCENES[scene];
  runSceneInternal(state.scene);
  addLog('device_control', `Scene ${scene.toUpperCase()} activated`, { source: 'web' });
  broadcast({ type: 'scene_changed', scene: state.scene });
  return ok(res);
});

// =====================================================
// SCENE CRUD V2 — READ API
// Database-backed scene management endpoints
// =====================================================

/**
 * GET /api/v2/scenes
 * Returns all scenes with their actions from the database
 */
app.get('/api/v2/scenes', requireWebAuth, async (req, res) => {
  try {
    // Query all scenes
    const [scenes] = await db.pool.query(
      'SELECT id, name, description, icon, is_system, timer_enabled, timer_minutes, timer_seconds, wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds, created_at, updated_at FROM scenes ORDER BY id'
    );

    // Query all actions
    const [actions] = await db.pool.query(
      'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order, created_at FROM scene_actions ORDER BY scene_id, execution_order'
    );

    // Group actions by scene_id
    const scenesWithActions = scenes.map(scene => ({
      ...scene,
      actions: actions.filter(action => action.scene_id === scene.id)
    }));

    return res.json({
      success: true,
      scenes: scenesWithActions
    });
  } catch (error) {
    console.error('[Scene CRUD] GET /api/v2/scenes error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve scenes'
    });
  }
});

/**
 * POST /api/v2/scenes/:id/run
 * Execute a scene by reading its actions from the database
 * IMPORTANT: This route must be defined BEFORE GET /api/v2/scenes/:id
 * to avoid Express matching :id as the scene ID instead of the specific /run endpoint
 */
app.post('/api/v2/scenes/:id/run', requireWebAuth, async (req, res) => {
  try {
    const sceneId = parseInt(req.params.id, 10);

    // Validate ID
    if (isNaN(sceneId) || sceneId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid scene ID'
      });
    }

    // Cancel any active sleep timer before executing any scene
    cancelSleepTimer();

    // Cancel any active Wake Up → Home timer before executing any scene
    cancelWakeHomeTimer();

    // Execute scene from database
    const result = await runSceneFromDB(sceneId);

    if (!result.success) {
      if (result.notFound) {
        return res.status(404).json({
          success: false,
          error: 'Scene not found'
        });
      } else {
        return res.status(500).json({
          success: false,
          error: 'Scene execution failed'
        });
      }
    }

    console.log('[Scene Execution] Scene', sceneId, 'executed successfully via API');

    // Check if this scene has sleep timer enabled
    const [scenes] = await db.pool.query(
      'SELECT timer_enabled, timer_minutes, timer_seconds FROM scenes WHERE id = ?',
      [sceneId]
    );

    if (scenes.length > 0 && scenes[0].timer_enabled) {
      const { timer_minutes, timer_seconds } = scenes[0];
      await startSleepTimer(sceneId, timer_minutes, timer_seconds);
      console.log(`[Sleep Timer] Started timer: ${timer_minutes}m ${timer_seconds}s for scene ${sceneId}`);
    }

    // Check if this is Wake Up scene and has Wake→Home timer enabled
    if (sceneId === WAKE_UP_SCENE_ID) {
      const [wakeUpScene] = await db.pool.query(
        'SELECT wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = ?',
        [sceneId]
      );

      if (wakeUpScene.length > 0) {
        const { wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds } = wakeUpScene[0];

        if (wake_home_timer_enabled && (wake_home_timer_minutes > 0 || wake_home_timer_seconds > 0)) {
          console.log(`[Wake→Home Timer] Started timer: ${wake_home_timer_minutes}m ${wake_home_timer_seconds}s for scene ${sceneId}`);
          await startWakeHomeTimer(sceneId, wake_home_timer_minutes, wake_home_timer_seconds);
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Scene executed successfully',
      sceneId: sceneId
    });

  } catch (error) {
    console.error('[Scene Execution] POST /api/v2/scenes/:id/run error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to execute scene'
    });
  }
});

/**
 * GET /api/v2/sleep-timer/status
 * Get the current timer status (Sleep Timer or Wake Up → Home Timer)
 */
app.get('/api/v2/sleep-timer/status', requireWebAuth, (req, res) => {
  const sleepStatus = getSleepTimerStatus();
  const wakeHomeStatus = getWakeHomeTimerStatus();

  // Determine which timer is active
  let timer = null;

  if (sleepStatus) {
    timer = {
      active: true,
      type: 'sleep_to_wake',
      sceneId: sleepStatus.sceneId,
      endTime: sleepStatus.endTime,
      remainingMinutes: sleepStatus.remainingMinutes,
      remainingSeconds: sleepStatus.remainingSeconds
    };
  } else if (wakeHomeStatus) {
    timer = {
      active: true,
      type: 'wake_to_home',
      sceneId: wakeHomeStatus.sceneId,
      endTime: wakeHomeStatus.endTime,
      remainingMinutes: wakeHomeStatus.remainingMinutes,
      remainingSeconds: wakeHomeStatus.remainingSeconds
    };
  }

  return res.json({
    success: true,
    timer: timer
  });
});

/**
 * GET /api/v2/scenes/:id
 * Returns a single scene with its actions by ID
 */
app.get('/api/v2/scenes/:id', requireWebAuth, async (req, res) => {
  try {
    const sceneId = parseInt(req.params.id, 10);

    // Validate ID
    if (isNaN(sceneId) || sceneId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid scene ID'
      });
    }

    // Query scene
    const [scenes] = await db.pool.query(
      'SELECT id, name, description, icon, is_system, timer_enabled, timer_minutes, timer_seconds, wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds, created_at, updated_at FROM scenes WHERE id = ?',
      [sceneId]
    );

    if (scenes.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scene not found'
      });
    }

    // Query actions for this scene
    const [actions] = await db.pool.query(
      'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order, created_at FROM scene_actions WHERE scene_id = ? ORDER BY execution_order',
      [sceneId]
    );

    const scene = {
      ...scenes[0],
      actions
    };

    return res.json({
      success: true,
      scene
    });
  } catch (error) {
    console.error('[Scene CRUD] GET /api/v2/scenes/:id error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve scene'
    });
  }
});

/**
 * POST /api/v2/scenes
 * Create a new user scene with actions
 */
app.post('/api/v2/scenes', requireWebAuth, async (req, res) => {
  const connection = await db.pool.getConnection();

  try {
    const { name, description, icon, actions } = req.body;

    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Request body must be a valid JSON object'
      });
    }

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Scene name is required and must be a non-empty string'
      });
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Scene name must not exceed 100 characters'
      });
    }

    // Validate description (optional)
    const validatedDescription = description !== undefined && description !== null
      ? (typeof description === 'string' ? description : null)
      : null;

    // Validate icon (optional)
    const validatedIcon = icon !== undefined && icon !== null
      ? (typeof icon === 'string' ? icon : null)
      : null;

    // Validate actions
    if (!Array.isArray(actions)) {
      return res.status(400).json({
        success: false,
        error: 'Actions must be an array'
      });
    }

    // Validate each action
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      if (!action || typeof action !== 'object') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must be an object`
        });
      }

      if (!action.device_type || typeof action.device_type !== 'string') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have a valid device_type`
        });
      }

      if (action.room !== null && action.room !== undefined && typeof action.room !== 'string') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} has invalid room (must be string or null)`
        });
      }

      if (!action.action_type || typeof action.action_type !== 'string') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have a valid action_type`
        });
      }

      if (action.action_value === undefined || action.action_value === null) {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have an action_value`
        });
      }

      if (typeof action.action_value !== 'string' && typeof action.action_value !== 'number' && typeof action.action_value !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} has invalid action_value type`
        });
      }

      if (action.execution_order === undefined || action.execution_order === null) {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have an execution_order`
        });
      }

      if (typeof action.execution_order !== 'number' || !Number.isInteger(action.execution_order)) {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} has invalid execution_order (must be an integer)`
        });
      }
    }

    // Begin transaction
    await connection.beginTransaction();

    // Insert scene (is_system = 0 for user-created scenes)
    const [sceneResult] = await connection.query(
      'INSERT INTO scenes (name, description, icon, is_system) VALUES (?, ?, ?, 0)',
      [trimmedName, validatedDescription, validatedIcon]
    );

    const sceneId = sceneResult.insertId;

    // Insert actions
    for (const action of actions) {
      await connection.query(
        'INSERT INTO scene_actions (scene_id, device_type, room, action_type, action_value, execution_order) VALUES (?, ?, ?, ?, ?, ?)',
        [
          sceneId,
          action.device_type,
          action.room || null,
          action.action_type,
          String(action.action_value),
          action.execution_order
        ]
      );
    }

    // Commit transaction
    await connection.commit();

    // Query the created scene with actions
    const [createdScene] = await connection.query(
      'SELECT id, name, description, icon, is_system, created_at, updated_at FROM scenes WHERE id = ?',
      [sceneId]
    );

    const [createdActions] = await connection.query(
      'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order, created_at FROM scene_actions WHERE scene_id = ? ORDER BY execution_order',
      [sceneId]
    );

    const newScene = {
      ...createdScene[0],
      actions: createdActions
    };

    console.log('[Scene CRUD] Created scene:', sceneId, '-', trimmedName, '- actions:', actions.length);

    return res.status(201).json({
      success: true,
      scene: newScene
    });

  } catch (error) {
    // Rollback on error
    await connection.rollback();
    console.error('[Scene CRUD] POST /api/v2/scenes error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to create scene'
    });
  } finally {
    connection.release();
  }
});

/**
 * PUT /api/v2/scenes/:id
 * Update an existing user scene with actions
 */
app.put('/api/v2/scenes/:id', requireWebAuth, async (req, res) => {
  const connection = await db.pool.getConnection();

  try {
    const sceneId = parseInt(req.params.id, 10);

    // Validate ID
    if (isNaN(sceneId) || sceneId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid scene ID'
      });
    }

    const {
      name,
      description,
      icon,
      actions,
      timer_enabled,
      timer_minutes,
      timer_seconds,
      wake_home_timer_enabled,
      wake_home_timer_minutes,
      wake_home_timer_seconds
    } = req.body;

    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Request body must be a valid JSON object'
      });
    }

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Scene name is required and must be a non-empty string'
      });
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Scene name must not exceed 100 characters'
      });
    }

    // Validate description (optional)
    const validatedDescription = description !== undefined && description !== null
      ? (typeof description === 'string' ? description : null)
      : null;

    // Validate icon (optional)
    const validatedIcon = icon !== undefined && icon !== null
      ? (typeof icon === 'string' ? icon : null)
      : null;

    // Validate actions
    if (!Array.isArray(actions)) {
      return res.status(400).json({
        success: false,
        error: 'Actions must be an array'
      });
    }

    // Validate each action
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      if (!action || typeof action !== 'object') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must be an object`
        });
      }

      if (!action.device_type || typeof action.device_type !== 'string') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have a valid device_type`
        });
      }

      if (action.room !== null && action.room !== undefined && typeof action.room !== 'string') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} has invalid room (must be string or null)`
        });
      }

      if (!action.action_type || typeof action.action_type !== 'string') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have a valid action_type`
        });
      }

      if (action.action_value === undefined || action.action_value === null) {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have an action_value`
        });
      }

      if (typeof action.action_value !== 'string' && typeof action.action_value !== 'number' && typeof action.action_value !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} has invalid action_value type`
        });
      }

      if (action.execution_order === undefined || action.execution_order === null) {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} must have an execution_order`
        });
      }

      if (typeof action.execution_order !== 'number' || !Number.isInteger(action.execution_order)) {
        return res.status(400).json({
          success: false,
          error: `Action at index ${i} has invalid execution_order (must be an integer)`
        });
      }
    }

    // Check if scene exists and get is_system flag
    const [existingScene] = await connection.query(
      'SELECT id, name, is_system FROM scenes WHERE id = ? FOR UPDATE',
      [sceneId]
    );

    if (existingScene.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        error: 'Scene not found'
      });
    }

    // Note: Both system and user scenes can now be edited
    // is_system flag remains unchanged during updates

    // Validate timer configuration from request body
    const timerEnabled = timer_enabled !== undefined ? (timer_enabled ? 1 : 0) : 0;
    const timerMinutes = timer_minutes !== undefined ? parseInt(timer_minutes, 10) : 0;
    const timerSeconds = timer_seconds !== undefined ? parseInt(timer_seconds, 10) : 0;

    // Validate Sleep Timer values
    if (isNaN(timerMinutes) || timerMinutes < 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: 'Timer minutes must be a non-negative number'
      });
    }

    if (isNaN(timerSeconds) || timerSeconds < 0 || timerSeconds > 59) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: 'Timer seconds must be between 0 and 59'
      });
    }

    // If Sleep Timer is enabled, total duration must be greater than 0
    if (timerEnabled && (timerMinutes === 0 && timerSeconds === 0)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: 'Timer duration must be greater than 0 when timer is enabled'
      });
    }

    // Validate Wake Up → Home timer configuration from request body
    const wakeHomeTimerEnabled = wake_home_timer_enabled !== undefined ? (wake_home_timer_enabled ? 1 : 0) : undefined;
    const wakeHomeTimerMinutes = wake_home_timer_minutes !== undefined ? parseInt(wake_home_timer_minutes, 10) : undefined;
    const wakeHomeTimerSeconds = wake_home_timer_seconds !== undefined ? parseInt(wake_home_timer_seconds, 10) : undefined;

    // Validate Wake Up → Home timer values if provided
    if (wakeHomeTimerMinutes !== undefined && (isNaN(wakeHomeTimerMinutes) || wakeHomeTimerMinutes < 0)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: 'Wake→Home timer minutes must be a non-negative number'
      });
    }

    if (wakeHomeTimerSeconds !== undefined && (isNaN(wakeHomeTimerSeconds) || wakeHomeTimerSeconds < 0 || wakeHomeTimerSeconds > 59)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: 'Wake→Home timer seconds must be between 0 and 59'
      });
    }

    // If Wake→Home Timer is enabled, total duration must be greater than 0
    if (wakeHomeTimerEnabled && wakeHomeTimerMinutes !== undefined && wakeHomeTimerSeconds !== undefined) {
      if (wakeHomeTimerMinutes === 0 && wakeHomeTimerSeconds === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: 'Wake→Home timer duration must be greater than 0 when timer is enabled'
        });
      }
    }

    // Build UPDATE query dynamically based on which timer fields are present
    let updateFields = ['name = ?', 'description = ?', 'icon = ?', 'timer_enabled = ?', 'timer_minutes = ?', 'timer_seconds = ?'];
    let updateValues = [trimmedName, validatedDescription, validatedIcon, timerEnabled, timerMinutes, timerSeconds];

    // Only update Wake→Home timer fields if they are explicitly provided in the request
    if (wakeHomeTimerEnabled !== undefined) {
      updateFields.push('wake_home_timer_enabled = ?');
      updateValues.push(wakeHomeTimerEnabled);
    }
    if (wakeHomeTimerMinutes !== undefined) {
      updateFields.push('wake_home_timer_minutes = ?');
      updateValues.push(wakeHomeTimerMinutes);
    }
    if (wakeHomeTimerSeconds !== undefined) {
      updateFields.push('wake_home_timer_seconds = ?');
      updateValues.push(wakeHomeTimerSeconds);
    }

    updateValues.push(sceneId);

    // Update scene metadata (is_system remains unchanged, timer configurations updated)
    await connection.query(
      `UPDATE scenes SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Delete existing actions
    await connection.query(
      'DELETE FROM scene_actions WHERE scene_id = ?',
      [sceneId]
    );

    // Insert new actions
    for (const action of actions) {
      await connection.query(
        'INSERT INTO scene_actions (scene_id, device_type, room, action_type, action_value, execution_order) VALUES (?, ?, ?, ?, ?, ?)',
        [
          sceneId,
          action.device_type,
          action.room || null,
          action.action_type,
          String(action.action_value),
          action.execution_order
        ]
      );
    }

    // Commit transaction
    await connection.commit();

    // Query the updated scene with actions
    const [updatedScene] = await connection.query(
      'SELECT id, name, description, icon, is_system, timer_enabled, timer_minutes, timer_seconds, created_at, updated_at FROM scenes WHERE id = ?',
      [sceneId]
    );

    const [updatedActions] = await connection.query(
      'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order, created_at FROM scene_actions WHERE scene_id = ? ORDER BY execution_order',
      [sceneId]
    );

    const scene = {
      ...updatedScene[0],
      actions: updatedActions
    };

    console.log('[Scene CRUD] Updated scene:', sceneId, '-', trimmedName, '- actions:', actions.length);

    return res.status(200).json({
      success: true,
      scene
    });

  } catch (error) {
    // Rollback on error
    await connection.rollback();
    console.error('[Scene CRUD] PUT /api/v2/scenes/:id error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to update scene'
    });
  } finally {
    connection.release();
  }
});

/**
 * DELETE /api/v2/scenes/:id
 * Delete an existing user scene
 */
app.delete('/api/v2/scenes/:id', requireWebAuth, async (req, res) => {
  const connection = await db.pool.getConnection();

  try {
    const sceneId = parseInt(req.params.id, 10);

    // Validate ID
    if (isNaN(sceneId) || sceneId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid scene ID'
      });
    }

    // Begin transaction
    await connection.beginTransaction();

    // Check if scene exists and get is_system flag
    const [existingScene] = await connection.query(
      'SELECT id, name, is_system FROM scenes WHERE id = ? FOR UPDATE',
      [sceneId]
    );

    if (existingScene.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        error: 'Scene not found'
      });
    }

    // Prevent deletion of system scenes
    if (existingScene[0].is_system === 1) {
      await connection.rollback();
      return res.status(403).json({
        success: false,
        error: 'Cannot delete system scenes'
      });
    }

    // Delete scene (CASCADE will automatically remove scene_actions)
    const [deleteResult] = await connection.query(
      'DELETE FROM scenes WHERE id = ?',
      [sceneId]
    );

    // Verify deletion
    if (deleteResult.affectedRows !== 1) {
      await connection.rollback();
      return res.status(500).json({
        success: false,
        error: 'Failed to delete scene'
      });
    }

    // Commit transaction
    await connection.commit();

    console.log('[Scene CRUD] Deleted scene:', sceneId, '-', existingScene[0].name);

    return res.status(200).json({
      success: true,
      message: 'Scene deleted successfully',
      id: sceneId
    });

  } catch (error) {
    // Rollback on error
    await connection.rollback();
    console.error('[Scene CRUD] DELETE /api/v2/scenes/:id error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete scene'
    });
  } finally {
    connection.release();
  }
});

/*
 * ตั้งค่า timeout ของ Automatic Mode - ESP32 เป็น source of truth เสมอ
 * ห้ามตั้ง state.autoSettings ที่นี่เพราะยังไม่ยืนยันว่าบอร์ดรับค่าจริง
 * ต้องรอ echo จาก home/status/auto/settings (ดู mqttClient.on('message'))
 * ก่อนอัปเดต state - Dashboard จะได้ค่าที่ยืนยันแล้วเท่านั้น ไม่ใช่ค่าที่ submit
 *
 * ต้อง register ก่อน /api/auto/:command ด้านล่าง - ไม่งั้น Express จะจับ
 * "settings" เป็นค่า :command แล้วตกไป fail ว่า "Invalid command: settings"
 * ก่อนจะมาถึง route นี้เลย (Express match route บนลงล่าง, :command กิน
 * segment ไหนก็ได้)
 */
app.post('/api/auto/settings', requireWebAuth, (req, res) => {
  console.log('[AUTO SETTINGS RX] endpoint called, body =', JSON.stringify(req.body));

  const { lightFanTimeout, acTimeout } = req.body || {};

  if (typeof lightFanTimeout !== 'number' || lightFanTimeout < 1 || lightFanTimeout > 300) {
    console.error('[AUTO SETTINGS RX] rejected: invalid lightFanTimeout', lightFanTimeout);
    return fail(res, 400, 'lightFanTimeout must be a number between 1 and 300');
  }
  if (typeof acTimeout !== 'number' || acTimeout < 1 || acTimeout > 600) {
    console.error('[AUTO SETTINGS RX] rejected: invalid acTimeout', acTimeout);
    return fail(res, 400, 'acTimeout must be a number between 1 and 600');
  }

  console.log('[AUTO SETTINGS RX] validated payload:', JSON.stringify({ lightFanTimeout, acTimeout }));

  const mqttPayload = { lightFanTimeout, acTimeout };
  console.log('[AUTO SETTINGS MQTT] topic: home/control/auto/settings');
  console.log('[AUTO SETTINGS MQTT] payload:', JSON.stringify(mqttPayload));

  const err = publish('home/control/auto/settings', mqttPayload);
  console.log('[AUTO SETTINGS MQTT] publish result:', err ? `FAILED - ${err}` : 'SUCCESS');
  if (err) return fail(res, 503, err);

  addLog('device_control', `Auto settings requested: lightFan=${lightFanTimeout}s ac=${acTimeout}s`, { source: 'web' });
  return ok(res);
});

// ใช้ทั้งจาก /api/auto/:command (user) และ scene engine (internal) - logic เดียวกัน
function setAutoMode(on) {
  const mode = on ? 'on' : 'off';
  state.autoMode = on;

  console.log('[AUTO DEBUG] Publishing MQTT: topic=home/control/auto payload=', JSON.stringify({ mode }));

  if (!mqttClient.connected) {
    console.error('[AUTO DEBUG] MQTT NOT CONNECTED - COMMAND NOT SENT');
    return 'MQTT not connected';
  }

  mqttClient.publish('home/control/auto', JSON.stringify({ mode }), { qos: 1 }, (err) => {
    if (err) {
      console.error('[AUTO DEBUG] MQTT PUBLISH FAILED', err);
    } else {
      console.log('[AUTO DEBUG] MQTT PUBLISH SUCCESS');
    }
  });

  addLog('device_control', `Auto mode ${mode.toUpperCase()}`, { source: 'web' });
  return null;
}

app.post('/api/auto/:command', requireWebAuth, (req, res) => {
  const { command } = req.params;
  console.log('[AUTO DEBUG] HTTP request received:', command.toUpperCase());

  if (!['on', 'off', 'enable', 'disable'].includes(command)) {
    console.error('[AUTO DEBUG] Invalid command param:', command);
    return fail(res, 400, `Invalid command: ${command}`);
  }

  const on = command === 'on' || command === 'enable';
  const error = setAutoMode(on);
  if (error) return fail(res, 503, error);
  return ok(res);
});


// ---------- Raw publish ----------

app.post('/api/command', requireWebAuth, (req, res) => {
  const { topic, payload } = req.body || {};
  if (!topic || typeof topic !== 'string') {
    return fail(res, 400, 'Field "topic" is required');
  }

  sendCommand(res, topic, payload ?? {}, `Custom command ${topic}`);
});

// ---------- History ----------

app.get('/api/history', requireWebAuth, async (req, res) => {
  try {
    // Parse and validate parameters
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const type = req.query.type || null;
    const room = req.query.room || null;

    // Check MySQL connection
    if (!db.isConnected()) {
      return fail(res, 503, 'Database unavailable');
    }

    // Query events
    const events = await db.queryEvents({ limit, offset, type, room });
    const total = await db.countEvents({ type, room });

    res.json({
      success: true,
      data: events,
      pagination: {
        limit,
        offset,
        total
      }
    });
  } catch (err) {
    console.error('[History API] Query failed:', err.message);
    fail(res, 500, 'Database query failed');
  }
});

app.delete('/api/history', requireWebAuth, async (req, res) => {
  try {
    // Check MySQL connection
    if (!db.isConnected()) {
      return fail(res, 503, 'Database unavailable');
    }

    // Clear all event history
    const deleted = await db.clearEvents();

    res.json({
      success: true,
      message: 'History cleared successfully',
      deleted
    });
  } catch (err) {
    console.error('[History API] Clear failed:', err.message);
    fail(res, 500, 'Failed to clear history');
  }
});

// ---------- Telegram Settings ----------

/**
 * Send Telegram test notification (separate from motion alerts)
 * Does NOT modify cooldown or check scene mode
 */
async function sendTelegramTestMessage() {
  if (!telegramBot || !TELEGRAM_CHAT_ID) {
    throw new Error('Telegram bot is not configured');
  }

  const timestamp = new Date().toISOString();
  const message = `🧪 Smart Home Test Notification

Telegram notification system is working correctly.

Timestamp: ${timestamp}`;

  await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message);
}

app.get('/api/telegram/settings', requireWebAuth, async (req, res) => {
  try {
    // Check MySQL connection
    if (!db.isConnected()) {
      return fail(res, 503, 'Database unavailable');
    }

    // Query all settings
    const [rows] = await db.pool.execute(
      'SELECT setting_key, setting_value FROM telegram_settings'
    );

    // Convert rows to settings object
    const settings = {};
    rows.forEach(row => {
      const key = row.setting_key;
      let value = row.setting_value;

      // Convert boolean strings
      if ([
        'telegram_enabled',
        'alert_motion_enabled',
        'alert_fingerprint_enabled',
        'alert_security_enabled',
        'motion_living_enabled',
        'motion_kitchen_enabled',
        'motion_bedroom_enabled'
      ].includes(key)) {
        value = value === 'true';
      }
      // Convert cooldown value to number
      else if (key === 'telegram_cooldown_value') {
        value = Number(value);
      }

      settings[key] = value;
    });

    res.json({
      success: true,
      settings
    });
  } catch (err) {
    console.error('[Telegram Settings API] Query failed:', err.message);
    fail(res, 500, 'Failed to load Telegram settings');
  }
});

app.post('/api/telegram/settings', requireWebAuth, async (req, res) => {
  let connection;

  try {
    // Validate request body
    if (!req.body.settings || typeof req.body.settings !== 'object' || Array.isArray(req.body.settings)) {
      return fail(res, 400, 'Settings object is required');
    }

    const settings = req.body.settings;
    const keys = Object.keys(settings);

    if (keys.length === 0) {
      return fail(res, 400, 'Settings object is required');
    }

    // Whitelist of allowed setting keys
    const allowedKeys = [
      'telegram_enabled',
      'telegram_cooldown_value',
      'telegram_cooldown_unit',
      'alert_motion_enabled',
      'alert_fingerprint_enabled',
      'alert_security_enabled',
      'motion_living_enabled',
      'motion_kitchen_enabled',
      'motion_bedroom_enabled'
    ];

    // Check for unknown keys
    for (const key of keys) {
      if (!allowedKeys.includes(key)) {
        return fail(res, 400, 'Invalid Telegram setting key');
      }
    }

    // Validate each setting
    for (const [key, value] of Object.entries(settings)) {
      // Boolean settings
      if ([
        'telegram_enabled',
        'alert_motion_enabled',
        'alert_fingerprint_enabled',
        'alert_security_enabled',
        'motion_living_enabled',
        'motion_kitchen_enabled',
        'motion_bedroom_enabled'
      ].includes(key)) {
        if (typeof value !== 'boolean') {
          return fail(res, 400, `Invalid value for ${key}: must be boolean`);
        }
      }
      // Cooldown value
      else if (key === 'telegram_cooldown_value') {
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 3600) {
          return fail(res, 400, 'Invalid telegram_cooldown_value');
        }
      }
      // Cooldown unit
      else if (key === 'telegram_cooldown_unit') {
        if (value !== 'seconds' && value !== 'minutes') {
          return fail(res, 400, 'Invalid telegram_cooldown_unit');
        }
      }
    }

    // Check MySQL connection
    if (!db.isConnected()) {
      return fail(res, 503, 'Database unavailable');
    }

    // Get connection for transaction
    connection = await db.pool.getConnection();
    await connection.beginTransaction();

    // Update each setting
    for (const [key, value] of Object.entries(settings)) {
      const stringValue = String(value);

      await connection.execute(
        `INSERT INTO telegram_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           setting_value = VALUES(setting_value),
           updated_at = CURRENT_TIMESTAMP`,
        [key, stringValue]
      );
    }

    await connection.commit();

    // Refresh in-memory settings cache after successful database update
    loadTelegramSettings().catch(err => {
      console.error('[Telegram Settings API] Failed to refresh cache:', err.message);
      console.warn('[Telegram Settings API] Using previous cached settings');
    });

    res.json({
      success: true,
      message: 'Telegram settings saved successfully'
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
    }
    console.error('[Telegram Settings API] Save failed:', err.message);
    fail(res, 500, 'Failed to save Telegram settings');
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.post('/api/telegram/test', requireWebAuth, async (req, res) => {
  try {
    // Check if Telegram is configured
    if (!telegramBot || !TELEGRAM_CHAT_ID) {
      return fail(res, 503, 'Telegram bot is not configured');
    }

    // Send test message
    await sendTelegramTestMessage();

    res.json({
      success: true,
      message: 'Test notification sent successfully'
    });
  } catch (err) {
    console.error('[Telegram Test API] Failed:', err.message);
    fail(res, 500, 'Failed to send Telegram test notification');
  }
});

// Fingerprint Users API
app.get('/api/fingerprint/users', requireWebAuth, async (req, res) => {
  try {
    const users = await db.getAllFingerprintUsers();
    res.json({
      success: true,
      users
    });
  } catch (err) {
    console.error('[Fingerprint Users API] Failed:', err.message);
    fail(res, 500, 'Failed to retrieve fingerprint users');
  }
});

// Fingerprint Admin Authorization API
app.post('/api/fingerprint/admin/request', (req, res) => {
  try {
    // Check if already authorized
    if (fingerprintAdminAuthorization.authorized) {
      const remainingMs = new Date(fingerprintAdminAuthorization.expiresAt) - Date.now();
      return res.json({
        success: true,
        message: 'Already authorized',
        authorized: true,
        user: fingerprintAdminAuthorization.authorizedUser,
        expiresIn: Math.ceil(remainingMs / 1000)
      });
    }

    // Check if request already pending
    if (fingerprintAdminAuthorization.pending) {
      const remainingMs = (fingerprintAdminAuthorization.requestedAt + ADMIN_AUTH_REQUEST_TIMEOUT) - Date.now();
      return res.json({
        success: true,
        message: 'Admin authorization request already pending',
        pending: true,
        expiresIn: Math.ceil(remainingMs / 1000)
      });
    }

    // Start new authorization request
    fingerprintAdminAuthorization.pending = true;
    fingerprintAdminAuthorization.requestedAt = Date.now();

    console.log('[FINGERPRINT ADMIN] Authorization request initiated');

    // Set timeout for request expiration
    adminAuthTimeoutTimer = setTimeout(() => {
      if (fingerprintAdminAuthorization.pending) {
        console.log('[FINGERPRINT ADMIN] Authorization request timeout');
        fingerprintAdminAuthorization.pending = false;
        fingerprintAdminAuthorization.requestedAt = null;
        adminAuthTimeoutTimer = null;

        broadcast({
          type: 'fingerprint_admin_timeout',
          message: 'Admin authorization request expired'
        });

        addLog('security', 'Admin authorization request timeout');
      }
    }, ADMIN_AUTH_REQUEST_TIMEOUT);

    addLog('security', 'Admin authorization requested for fingerprint management');

    res.json({
      success: true,
      message: 'Please scan an ADMIN fingerprint',
      pending: true,
      expiresIn: ADMIN_AUTH_REQUEST_TIMEOUT / 1000
    });
  } catch (err) {
    console.error('[Fingerprint Admin Request API] Failed:', err.message);
    fail(res, 500, 'Failed to initiate admin authorization');
  }
});

app.get('/api/fingerprint/admin/status', requireWebAuth, (req, res) => {
  try {
    const response = {
      success: true,
      pending: fingerprintAdminAuthorization.pending,
      authorized: fingerprintAdminAuthorization.authorized
    };

    if (fingerprintAdminAuthorization.authorized) {
      response.user = fingerprintAdminAuthorization.authorizedUser;
      response.expiresAt = fingerprintAdminAuthorization.expiresAt;
      response.remainingSeconds = Math.ceil((new Date(fingerprintAdminAuthorization.expiresAt) - Date.now()) / 1000);
    }

    res.json(response);
  } catch (err) {
    console.error('[Fingerprint Admin Status API] Failed:', err.message);
    fail(res, 500, 'Failed to retrieve admin authorization status');
  }
});

app.post('/api/fingerprint/admin/logout', (req, res) => {
  try {
    console.log('[FINGERPRINT ADMIN] Manual logout');

    // Clear timers
    if (adminAuthTimeoutTimer) {
      clearTimeout(adminAuthTimeoutTimer);
      adminAuthTimeoutTimer = null;
    }

    // Clear authorization
    const wasAuthorized = fingerprintAdminAuthorization.authorized;
    fingerprintAdminAuthorization.pending = false;
    fingerprintAdminAuthorization.requestedAt = null;
    fingerprintAdminAuthorization.authorized = false;
    fingerprintAdminAuthorization.authorizedUser = null;
    fingerprintAdminAuthorization.authorizedAt = null;
    fingerprintAdminAuthorization.expiresAt = null;

    broadcast({
      type: 'fingerprint_admin_logout',
      message: 'Admin authorization ended'
    });

    if (wasAuthorized) {
      addLog('security', 'Admin authorization manually ended');
    }

    res.json({
      success: true,
      message: 'Admin authorization cleared'
    });
  } catch (err) {
    console.error('[Fingerprint Admin Logout API] Failed:', err.message);
    fail(res, 500, 'Failed to clear admin authorization');
  }
});

// Fingerprint Enrollment API
app.post('/api/fingerprint/enroll', async (req, res) => {
  try {
    // Check admin authorization
    if (!fingerprintAdminAuthorization.authorized) {
      return fail(res, 403, 'Admin authorization required');
    }

    // Check authorization not expired
    const now = new Date();
    const expiresAt = new Date(fingerprintAdminAuthorization.expiresAt);
    if (now >= expiresAt) {
      return fail(res, 403, 'Admin authorization expired');
    }

    // Check if enrollment already active
    if (fingerprintEnrollment.active) {
      return fail(res, 409, 'Another enrollment is already in progress');
    }

    // Check maximum capacity (10 fingerprints)
    const allUsers = await db.getAllFingerprintUsers();
    if (allUsers.length >= 10) {
      return fail(res, 403, 'Maximum fingerprint capacity (10) reached. Delete a fingerprint before enrolling.');
    }

    // Validate request body
    const { fingerprintId, name, role } = req.body;

    if (!fingerprintId || typeof fingerprintId !== 'number') {
      return fail(res, 400, 'Valid fingerprintId is required');
    }

    if (fingerprintId < 1 || fingerprintId > 10) {
      return fail(res, 400, 'Fingerprint ID must be between 1 and 10');
    }

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return fail(res, 400, 'Name must be at least 2 characters');
    }

    if (role !== 'ADMIN' && role !== 'USER') {
      return fail(res, 400, 'Role must be ADMIN or USER');
    }

    // Check if fingerprint ID already exists
    const existing = await db.getFingerprintUser(fingerprintId);
    if (existing) {
      return fail(res, 409, `Fingerprint ID ${fingerprintId} is already registered`);
    }

    // Set enrollment state
    fingerprintEnrollment.active = true;
    fingerprintEnrollment.fingerprintId = fingerprintId;
    fingerprintEnrollment.name = name.trim();
    fingerprintEnrollment.role = role;
    fingerprintEnrollment.startedBy = fingerprintAdminAuthorization.authorizedUser;
    fingerprintEnrollment.startedAt = new Date().toISOString();

    // Set timeout
    enrollmentTimeoutTimer = setTimeout(() => {
      if (fingerprintEnrollment.active) {
        console.log('[FINGERPRINT ENROLLMENT] Timeout - cancelling');

        // Send cancel command to ESP32
        publish('home/control/fingerprint/enroll', { action: 'cancel' });

        addLog('security', 'Fingerprint enrollment timeout', {
          fingerprintId: fingerprintEnrollment.fingerprintId,
          name: fingerprintEnrollment.name
        });

        broadcast({
          type: 'fingerprint_enrollment_timeout'
        });

        // Clear enrollment state
        fingerprintEnrollment.active = false;
        fingerprintEnrollment.fingerprintId = null;
        fingerprintEnrollment.name = null;
        fingerprintEnrollment.role = null;
        fingerprintEnrollment.startedBy = null;
        fingerprintEnrollment.startedAt = null;
        enrollmentTimeoutTimer = null;
      }
    }, FINGERPRINT_ENROLLMENT_TIMEOUT);

    // Send enrollment command to ESP32
    const error = publish('home/control/fingerprint/enroll', {
      action: 'start',
      fingerprintId
    });

    if (error) {
      // Clear enrollment state on MQTT failure
      fingerprintEnrollment.active = false;
      fingerprintEnrollment.fingerprintId = null;
      fingerprintEnrollment.name = null;
      fingerprintEnrollment.role = null;
      fingerprintEnrollment.startedBy = null;
      fingerprintEnrollment.startedAt = null;

      if (enrollmentTimeoutTimer) {
        clearTimeout(enrollmentTimeoutTimer);
        enrollmentTimeoutTimer = null;
      }

      return fail(res, 503, 'MQTT not connected');
    }

    console.log('[FINGERPRINT ENROLLMENT] Started:', { fingerprintId, name, role });

    addLog('security', `Fingerprint enrollment started: ${name} (${role}) - ID ${fingerprintId}`, {
      fingerprintId,
      name,
      role,
      startedBy: fingerprintEnrollment.startedBy
    });

    broadcast({
      type: 'fingerprint_enrollment_started',
      fingerprintId,
      name,
      role
    });

    res.json({
      success: true,
      message: 'Enrollment started'
    });
  } catch (err) {
    console.error('[Fingerprint Enrollment API] Failed:', err.message);
    fail(res, 500, 'Failed to start enrollment');
  }
});

app.post('/api/fingerprint/enroll/cancel', (req, res) => {
  try {
    // Check admin authorization
    if (!fingerprintAdminAuthorization.authorized) {
      return fail(res, 403, 'Admin authorization required');
    }

    // Check if enrollment is active
    if (!fingerprintEnrollment.active) {
      return fail(res, 400, 'No active enrollment to cancel');
    }

    console.log('[FINGERPRINT ENROLLMENT] Cancel requested');

    // Send cancel command to ESP32
    const error = publish('home/control/fingerprint/enroll', { action: 'cancel' });

    if (error) {
      return fail(res, 503, 'MQTT not connected');
    }

    // Note: Don't clear enrollment state here - wait for ESP32 confirmation

    res.json({
      success: true,
      message: 'Cancellation sent'
    });
  } catch (err) {
    console.error('[Fingerprint Enrollment Cancel API] Failed:', err.message);
    fail(res, 500, 'Failed to cancel enrollment');
  }
});

// Fingerprint Deletion API
app.delete('/api/fingerprint/users/:fingerprintId', async (req, res) => {
  try {
    // Check admin authorization
    if (!fingerprintAdminAuthorization.authorized) {
      return fail(res, 403, 'Admin authorization required');
    }

    // Check authorization not expired
    const now = new Date();
    const expiresAt = new Date(fingerprintAdminAuthorization.expiresAt);
    if (now >= expiresAt) {
      return fail(res, 403, 'Admin authorization expired');
    }

    // Parse and validate fingerprint ID
    const fingerprintId = parseInt(req.params.fingerprintId);

    if (!fingerprintId || typeof fingerprintId !== 'number') {
      return fail(res, 400, 'Valid fingerprintId is required');
    }

    if (fingerprintId < 1 || fingerprintId > 127) {
      return fail(res, 400, 'Fingerprint ID must be between 1 and 127');
    }

    // Protect Fingerprint ID 1 (Primary Administrator)
    if (fingerprintId === 1) {
      return fail(res, 403, 'Primary Administrator fingerprint cannot be deleted');
    }

    // Check if user exists
    const user = await db.getFingerprintUser(fingerprintId);
    if (!user) {
      return fail(res, 404, `Fingerprint ID ${fingerprintId} not found`);
    }

    // Check if deletion already active
    if (fingerprintDeletion.active) {
      return fail(res, 409, 'Another deletion is already in progress');
    }

    // Check if enrollment is active
    if (fingerprintEnrollment.active) {
      return fail(res, 409, 'Cannot delete fingerprint while enrollment is active');
    }

    // Set deletion state
    fingerprintDeletion.active = true;
    fingerprintDeletion.fingerprintId = fingerprintId;
    fingerprintDeletion.requestedAt = new Date().toISOString();

    // Set timeout
    deletionTimeoutTimer = setTimeout(() => {
      if (fingerprintDeletion.active) {
        console.log('[FINGERPRINT DELETION] Timeout - operation failed');

        addLog('security', 'Fingerprint deletion timeout', {
          fingerprintId: fingerprintDeletion.fingerprintId
        });

        broadcast({
          type: 'fingerprint_deletion_timeout',
          fingerprintId: fingerprintDeletion.fingerprintId
        });

        // Clear deletion state (do NOT delete database record)
        fingerprintDeletion.active = false;
        fingerprintDeletion.fingerprintId = null;
        fingerprintDeletion.requestedAt = null;
        deletionTimeoutTimer = null;
      }
    }, FINGERPRINT_DELETION_TIMEOUT);

    // Send deletion command to ESP32
    const error = publish('home/control/fingerprint/delete', {
      action: 'delete',
      fingerprintId
    });

    if (error) {
      // Clear deletion state on MQTT failure
      fingerprintDeletion.active = false;
      fingerprintDeletion.fingerprintId = null;
      fingerprintDeletion.requestedAt = null;

      if (deletionTimeoutTimer) {
        clearTimeout(deletionTimeoutTimer);
        deletionTimeoutTimer = null;
      }

      return fail(res, 503, 'MQTT not connected');
    }

    console.log('[FINGERPRINT DELETION] Started:', { fingerprintId, name: user.name, role: user.role });

    addLog('security', `Fingerprint deletion started: ${user.name} (${user.role}) - ID ${fingerprintId}`, {
      fingerprintId,
      name: user.name,
      role: user.role
    });

    broadcast({
      type: 'fingerprint_deletion_started',
      fingerprintId,
      name: user.name
    });

    res.json({
      success: true,
      message: 'Deletion started'
    });
  } catch (err) {
    console.error('[Fingerprint Deletion API] Failed:', err.message);
    fail(res, 500, 'Failed to start deletion');
  }
});

/* =====================================================
   WEB DASHBOARD AUTHENTICATION
   Session-based login for web access (separate from fingerprint auth)
===================================================== */

/**
 * Authentication middleware - protects routes requiring web login
 * Use this in Phase 3+ to protect Smart Home APIs
 */
function requireWebAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({
    success: false,
    message: 'Unauthorized - login required'
  });
}

/**
 * POST /api/auth/login
 * Authenticate with username/email + password
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Require password and (username OR email)
    if (!password || (!username && !email)) {
      return res.status(400).json({
        success: false,
        message: 'Username/email and password are required'
      });
    }

    // Look up user by username OR email
    const query = username
      ? 'SELECT id, username, email, password_hash, full_name, role, created_at, last_login, active FROM web_users WHERE username = ? AND active = 1'
      : 'SELECT id, username, email, password_hash, full_name, role, created_at, last_login, active FROM web_users WHERE email = ? AND active = 1';
    const [rows] = await db.pool.execute(query, [username || email]);

    if (rows.length === 0) {
      // Generic error - don't reveal if user exists
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = rows[0];

    // Verify password with bcrypt
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last_login
    await db.pool.execute(
      'UPDATE web_users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    // Create session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    // Return safe user object (no password_hash)
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role
      }
    });

    console.log(`[AUTH] User logged in: ${user.username} (${user.role})`);
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

/**
 * POST /api/auth/logout
 * Destroy session
 */
app.post('/api/auth/logout', (req, res) => {
  const username = req.session?.username || 'unknown';

  req.session.destroy((err) => {
    if (err) {
      console.error('[AUTH] Logout error:', err);
      return res.status(500).json({
        success: false,
        message: 'Logout failed'
      });
    }

    res.clearCookie('connect.sid');
    res.json({
      success: true,
      message: 'Logged out successfully'
    });

    console.log(`[AUTH] User logged out: ${username}`);
  });
});

/**
 * GET /api/auth/session
 * Check current session status
 */
app.get('/api/auth/session', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      authenticated: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      }
    });
  }

  res.json({
    authenticated: false
  });
});

// ---------- Fallback ----------

/* =====================================================
   WEB USER MANAGEMENT (ADMIN ONLY)
   Operates on web_users only. Completely separate from
   fingerprint_users / physical fingerprint authorization.
===================================================== */

const WEB_USER_COLUMNS =
  'id, username, email, full_name, role, created_at, last_login, active';

/**
 * ADMIN-only gate. Layered on top of the existing session check so
 * an authenticated USER still cannot reach management endpoints.
 */
function requireWebAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized - login required' });
  }
  if (req.session.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Administrator privileges required' });
  }
  return next();
}

/** Count currently active ADMIN accounts */
async function countActiveAdmins() {
  const [rows] = await db.pool.execute(
    "SELECT COUNT(*) AS total FROM web_users WHERE role = 'ADMIN' AND active = 1"
  );
  return rows[0].total;
}

// GET /api/users - list web users (safe columns only)
app.get('/api/users', requireWebAdmin, async (req, res) => {
  try {
    const [rows] = await db.pool.execute(
      `SELECT ${WEB_USER_COLUMNS} FROM web_users ORDER BY id ASC`
    );
    res.json({ success: true, users: rows });
  } catch (err) {
    console.error('[USERS] List failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load users' });
  }
});

// POST /api/users - create a new web user
app.post('/api/users', requireWebAdmin, async (req, res) => {
  try {
    const { username, email, password, full_name, role } = req.body || {};

    if (!username || !email || !password || !full_name || !role) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (String(username).trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    if (role !== 'ADMIN' && role !== 'USER') {
      return res.status(400).json({ success: false, message: 'Role must be ADMIN or USER' });
    }

    const uname = String(username).trim();
    const mail = String(email).trim();

    const [dupe] = await db.pool.execute(
      'SELECT username, email FROM web_users WHERE username = ? OR email = ?',
      [uname, mail]
    );
    if (dupe.length > 0) {
      const conflict = dupe[0].username === uname ? 'Username already exists' : 'Email already exists';
      return res.status(409).json({ success: false, message: conflict });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    await db.pool.execute(
      'INSERT INTO web_users (username, email, password_hash, full_name, role, active) VALUES (?, ?, ?, ?, ?, 1)',
      [uname, mail, passwordHash, String(full_name).trim(), role]
    );

    console.log(`[USERS] Account created: ${uname} (${role}) by ${req.session.username}`);
    addLog('security', `Web account created: ${uname} (${role})`, {
      action: 'web_user_create',
      createdBy: req.session.username
    });

    res.json({ success: true, message: 'User created successfully' });
  } catch (err) {
    console.error('[USERS] Create failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
});

// PUT /api/users/:id - update profile fields / role / active state
app.put('/api/users/:id', requireWebAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    // password_hash is never accepted from the client
    const { username, email, full_name, role, active } = req.body || {};

    if (!username || !email || !full_name || !role) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    if (role !== 'ADMIN' && role !== 'USER') {
      return res.status(400).json({ success: false, message: 'Role must be ADMIN or USER' });
    }

    const nextActive = (active === 0 || active === false || active === '0') ? 0 : 1;

    const [existingRows] = await db.pool.execute(
      `SELECT ${WEB_USER_COLUMNS} FROM web_users WHERE id = ?`,
      [id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const target = existingRows[0];

    // Self-protection: cannot demote or disable your own logged-in account
    if (id === req.session.userId) {
      if (nextActive === 0) {
        return res.status(400).json({ success: false, message: 'You cannot disable your own account' });
      }
      if (role !== 'ADMIN') {
        return res.status(400).json({ success: false, message: 'You cannot remove your own administrator role' });
      }
    }

    // Last-active-ADMIN protection
    const losingAdmin = target.role === 'ADMIN' && target.active === 1 && (role !== 'ADMIN' || nextActive === 0);
    if (losingAdmin && (await countActiveAdmins()) <= 1) {
      return res.status(409).json({
        success: false,
        message: 'At least one active administrator account must remain'
      });
    }

    const uname = String(username).trim();
    const mail = String(email).trim();

    const [dupe] = await db.pool.execute(
      'SELECT username, email FROM web_users WHERE (username = ? OR email = ?) AND id <> ?',
      [uname, mail, id]
    );
    if (dupe.length > 0) {
      const conflict = dupe[0].username === uname ? 'Username already exists' : 'Email already exists';
      return res.status(409).json({ success: false, message: conflict });
    }

    await db.pool.execute(
      'UPDATE web_users SET username = ?, email = ?, full_name = ?, role = ?, active = ? WHERE id = ?',
      [uname, mail, String(full_name).trim(), role, nextActive, id]
    );

    console.log(`[USERS] Account updated: id=${id} by ${req.session.username}`);
    addLog('security', `Web account updated: ${uname} (${role}, ${nextActive ? 'active' : 'disabled'})`, {
      action: 'web_user_update',
      updatedBy: req.session.username
    });

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('[USERS] Update failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
});

// DELETE /api/users/:id - remove a web account
app.delete('/api/users/:id', requireWebAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    if (id === req.session.userId) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }

    const [rows] = await db.pool.execute(
      `SELECT ${WEB_USER_COLUMNS} FROM web_users WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const target = rows[0];

    if (target.role === 'ADMIN' && target.active === 1 && (await countActiveAdmins()) <= 1) {
      return res.status(409).json({
        success: false,
        message: 'At least one active administrator account must remain'
      });
    }

    await db.pool.execute('DELETE FROM web_users WHERE id = ?', [id]);

    console.log(`[USERS] Account deleted: id=${id} by ${req.session.username}`);
    addLog('security', `Web account deleted: ${target.username}`, {
      action: 'web_user_delete',
      deletedBy: req.session.username
    });

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('[USERS] Delete failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  }
});

app.use('/api', (req, res) => fail(res, 404, 'Endpoint not found'));

/* =====================================================
   STARTUP / SHUTDOWN
===================================================== */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[SERVER] http://localhost:${PORT}`));

function shutdown() {
  console.log('\n[SERVER] Shutting down...');
  wss.clients.forEach(c => c.close());
  mqttClient.end(true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
