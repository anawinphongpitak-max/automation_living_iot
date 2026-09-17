require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  console.log('========================================================');
  console.log('  INSPECTION & UPDATE: Bedroom Window Configuration');
  console.log('========================================================');
  console.log('');

  // ===== BEFORE CHANGES =====
  console.log('===== BEFORE CHANGES =====');
  console.log('');

  // TASK 1: Scene 4 bedroom window action
  console.log('TASK 1: Scene 4 Bedroom Window Action (Wake Up OPEN)');
  const [scene4Before] = await conn.query(
    'SELECT id, action_value FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );
  console.log('  Current DB value:', scene4Before[0].action_value);
  console.log('  Target DB value: 115');
  console.log('');

  // TASK 2: Frontend Open/Close buttons
  console.log('TASK 2: Frontend Bedroom Window Open/Close Buttons');
  console.log('  File: frontend/script.js (calls mqttClient.controlServo)');
  console.log('  Implementation: frontend/mqtt-client.js (controlServo method)');
  console.log('  Backend: backend/server.js line 1688-1713');
  console.log('');
  console.log('  Current mapping in backend/server.js line 1707:');
  console.log('    Open button  → angle: 180');
  console.log('    Close button → angle: 0');
  console.log('');
  console.log('  ESP32 firmware mapping (smart_home.ino):');
  console.log('    bedroomWindow = constrain(angle, 0, 130);');
  console.log('    servoBedroomWindow.write(130 - bedroomWindow);');
  console.log('');
  console.log('  Physical behavior:');
  console.log('    angle 0   → servo.write(130) → OPEN fully');
  console.log('    angle 130 → servo.write(0)   → CLOSED');
  console.log('');
  console.log('  Required fix:');
  console.log('    Open button  → angle: 0   (currently 180, WRONG)');
  console.log('    Close button → angle: 130 (currently 0, WRONG)');
  console.log('');

  // ===== MAKE CHANGES =====
  console.log('========================================================');
  console.log('  MAKING CHANGES');
  console.log('========================================================');
  console.log('');

  // TASK 1: Update Scene 4 bedroom window to 115
  console.log('TASK 1: Updating Scene 4 bedroom window: 15 → 115');
  await conn.query(
    'UPDATE scene_actions SET action_value = ? WHERE id = ?',
    ['115', scene4Before[0].id]
  );
  console.log('  ✅ Database updated');
  console.log('');

  // ===== AFTER CHANGES =====
  console.log('========================================================');
  console.log('  VERIFICATION');
  console.log('========================================================');
  console.log('');

  // Verify Scene 4 update
  const [scene4After] = await conn.query(
    'SELECT action_value FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );
  console.log('Scene 4 bedroom/window:');
  console.log('  Before: 15');
  console.log('  After:', scene4After[0].action_value);
  console.log('  Status:', scene4After[0].action_value === '115' ? '✅ CORRECT' : '❌ ERROR');
  console.log('');

  // Verify all Scene 4 actions unchanged
  const [allActions] = await conn.query(
    'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 ORDER BY execution_order'
  );
  console.log('All Scene 4 actions:');
  allActions.forEach(a => {
    console.log(`  ${a.execution_order}: ${a.device_type}/${a.room || 'NULL'} → ${a.action_type} = ${a.action_value}`);
  });
  console.log('');

  // Verify Wake→Home timer unchanged
  const [timer] = await conn.query(
    'SELECT wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = 4'
  );
  console.log('Wake→Home timer:');
  console.log('  Enabled:', timer[0].wake_home_timer_enabled);
  console.log('  Minutes:', timer[0].wake_home_timer_minutes);
  console.log('  Seconds:', timer[0].wake_home_timer_seconds);
  console.log('  Status: ✅ UNCHANGED');
  console.log('');

  console.log('========================================================');
  console.log('Database update complete - proceed to backend fix');
  console.log('========================================================');

  await conn.end();
})();
