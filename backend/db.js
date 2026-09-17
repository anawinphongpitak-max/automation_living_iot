/* =====================================================
   MySQL DATABASE MODULE
   Connection pool and query functions for event history
===================================================== */

const mysql = require('mysql2/promise');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_home_iot',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  connectTimeout: 10000
});

// Connection state
let connected = false;

// Test connection on startup
pool.getConnection()
  .then(connection => {
    console.log('[MySQL] Connection pool established');
    connected = true;
    connection.release();
  })
  .catch(err => {
    console.error('[MySQL] Initial connection failed:', err.message);
    connected = false;
  });

// Monitor connection health
setInterval(() => {
  pool.query('SELECT 1')
    .then(() => {
      if (!connected) {
        console.log('[MySQL] Connection restored');
        connected = true;
      }
    })
    .catch(() => {
      if (connected) {
        console.error('[MySQL] Connection lost');
        connected = false;
      }
    });
}, 30000); // Check every 30 seconds

/**
 * Check if MySQL is connected
 */
function isConnected() {
  return connected;
}

/**
 * Parse room from message string
 */
function parseRoom(message) {
  const rooms = ['living', 'kitchen', 'bedroom'];
  const lowerMsg = message.toLowerCase();
  for (const room of rooms) {
    if (lowerMsg.includes(room)) return room;
  }
  return null;
}

/**
 * Parse device from message string
 */
function parseDevice(message) {
  if (message.includes('LED')) return 'LED';
  if (message.includes('Fan') || message.includes('fan')) return 'Fan';
  if (message.includes('AC')) return 'AC';
  if (message.includes('Window') || message.includes('window')) return 'Window';
  if (message.includes('Curtain') || message.includes('curtain')) return 'Curtain';
  if (message.includes('Door')) return 'Door';
  if (message.includes('Motion detected')) return 'PIR';
  if (message.includes('Fingerprint')) return 'Fingerprint';
  return null;
}

/**
 * Map backend type to database event_type
 */
function mapEventType(type, message) {
  if (type === 'system') return 'SYSTEM_EVENT';
  if (type === 'sensor') return 'MOTION';
  if (type === 'security') {
    if (message.includes('Fingerprint') && message.includes('authenticated successfully')) {
      return 'FINGERPRINT';
    }
    return 'SECURITY_ALERT';
  }
  if (type === 'device_control') {
    if (message.includes('Scene')) return 'SCENE_CHANGE';
    if (message.includes('Auto mode')) return 'AUTO_ACTION';
    if (message.includes('Door')) return 'DOOR_EVENT';
    return 'DEVICE_CONTROL';
  }
  return 'UNKNOWN';
}

/**
 * Normalize event data for database
 */
function normalizeEvent(event) {
  return {
    event_type: mapEventType(event.type, event.message),
    room: event.room || parseRoom(event.message),
    device: parseDevice(event.message),
    message: event.message,
    details: JSON.stringify(event),
    created_at: event.timestamp
      ? new Date(event.timestamp).toISOString().slice(0, 19).replace('T', ' ')
      : null
  };
}

/**
 * Insert event into database
 */
async function insertEvent(normalized) {
  const query = `
    INSERT INTO event_history (event_type, room, device, message, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  await pool.execute(query, [
    normalized.event_type,
    normalized.room,
    normalized.device,
    normalized.message,
    normalized.details,
    normalized.created_at
  ]);
}

/**
 * Query events with filters and pagination
 */
async function queryEvents({ limit = 50, offset = 0, type, room }) {
  let query = 'SELECT * FROM event_history WHERE 1=1';
  const params = [];

  if (type) {
    query += ' AND event_type = ?';
    params.push(type);
  }

  if (room) {
    query += ' AND room = ?';
    params.push(room);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [rows] = await pool.execute(query, params);
  return rows;
}

/**
 * Count total events with filters
 */
async function countEvents({ type, room }) {
  let query = 'SELECT COUNT(*) as total FROM event_history WHERE 1=1';
  const params = [];

  if (type) {
    query += ' AND event_type = ?';
    params.push(type);
  }

  if (room) {
    query += ' AND room = ?';
    params.push(room);
  }

  const [rows] = await pool.execute(query, params);
  return rows[0].total;
}

/**
 * Clear all event history records
 */
async function clearEvents() {
  const [result] = await pool.execute('DELETE FROM event_history');
  return result.affectedRows;
}

/**
 * Get fingerprint user by fingerprint ID
 */
async function getFingerprintUser(fingerprintId) {
  const query = 'SELECT * FROM fingerprint_users WHERE fingerprint_id = ?';
  const [rows] = await pool.execute(query, [fingerprintId]);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Get all fingerprint users
 */
async function getAllFingerprintUsers() {
  const query = 'SELECT * FROM fingerprint_users ORDER BY created_at DESC';
  const [rows] = await pool.execute(query);
  return rows;
}

/**
 * Insert new fingerprint user
 */
async function insertFingerprintUser(fingerprintId, name, role) {
  const query = 'INSERT INTO fingerprint_users (fingerprint_id, name, role) VALUES (?, ?, ?)';
  const [result] = await pool.execute(query, [fingerprintId, name, role]);
  return result;
}

/**
 * Delete fingerprint user by fingerprint ID
 */
async function deleteFingerprintUser(fingerprintId) {
  const query = 'DELETE FROM fingerprint_users WHERE fingerprint_id = ?';
  const [result] = await pool.execute(query, [fingerprintId]);
  return result;
}

module.exports = {
  pool,
  isConnected,
  normalizeEvent,
  insertEvent,
  queryEvents,
  countEvents,
  clearEvents,
  getFingerprintUser,
  getAllFingerprintUsers,
  insertFingerprintUser,
  deleteFingerprintUser
};
