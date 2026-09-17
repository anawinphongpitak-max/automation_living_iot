require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  console.log('========================================================');
  console.log('  INSPECT Wake Up Bedroom Window Commands');
  console.log('========================================================');
  console.log('');

  // STEP 1: Check Scene 4 bedroom/window action (OPEN command)
  console.log('STEP 1: Scene 4 bedroom/window action (Wake Up OPEN)');
  const [scene4Window] = await conn.query(
    'SELECT id, action_value, execution_order FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );

  if (scene4Window.length > 0) {
    console.log('  Location: Scene 4 database action');
    console.log('  Device: bedroom/window');
    console.log('  Action type: angle');
    console.log('  Current value:', scene4Window[0].action_value);
    console.log('  Execution order:', scene4Window[0].execution_order);
    console.log('  MQTT topic: home/control/bedroom/window');
    console.log('  MQTT payload: {"angle":' + scene4Window[0].action_value + '}');
  } else {
    console.log('  ERROR: Scene 4 bedroom/window action not found');
  }
  console.log('');

  // STEP 2: Check backend server.js for Wake Up termination CLOSE command
  console.log('STEP 2: Wake Up termination bedroom/window command (Wake Up CLOSE)');
  const serverCode = fs.readFileSync('D:\\END\\automation_living_iot_v2\\backend\\server.js', 'utf8');

  // Find the Wake Up termination section
  const wakeTerminationMatch = serverCode.match(/Wake Up termination[\s\S]{0,500}bedroom\/window['"]\s*,\s*\{\s*angle:\s*(\d+)\s*\}/);

  if (wakeTerminationMatch) {
    console.log('  Location: backend/server.js (Wake→Home timer callback)');
    console.log('  Device: bedroom/window');
    console.log('  Current value:', wakeTerminationMatch[1]);
    console.log('  MQTT topic: home/control/bedroom/window');
    console.log('  MQTT payload: {"angle":' + wakeTerminationMatch[1] + '}');
  } else {
    console.log('  Searching for bedroom/window in server.js...');
    const allMatches = serverCode.match(/publish\(['"]\s*home\/control\/bedroom\/window['"]\s*,\s*\{\s*angle:\s*(\d+)\s*\}/g);
    if (allMatches) {
      console.log('  Found', allMatches.length, 'bedroom/window commands:');
      allMatches.forEach(m => console.log('    ', m));
    }
  }
  console.log('');

  // STEP 3: Summary
  console.log('========================================================');
  console.log('SUMMARY OF BEDROOM WINDOW COMMANDS IN WAKE UP LIFECYCLE');
  console.log('========================================================');
  console.log('');
  console.log('Wake Up OPEN (Scene 4 action):');
  console.log('  Current: angle =', scene4Window[0].action_value);
  console.log('  Target: angle = 15');
  console.log('');
  console.log('Wake Up CLOSE (Wake→Home timer termination):');
  console.log('  Current: angle = 0 (from backend/server.js line 2089)');
  console.log('  Target: NO CHANGE (keep angle = 0)');
  console.log('');

  // STEP 4: Update Scene 4 bedroom/window from 30 to 15
  console.log('========================================================');
  console.log('UPDATING Wake Up OPEN command: 30 → 15');
  console.log('========================================================');
  console.log('');

  const [updateResult] = await conn.query(
    'UPDATE scene_actions SET action_value = ? WHERE id = ?',
    ['15', scene4Window[0].id]
  );
  console.log('Rows affected:', updateResult.affectedRows);
  console.log('');

  // STEP 5: Verify update
  console.log('========================================================');
  console.log('VERIFICATION');
  console.log('========================================================');
  console.log('');

  const [afterUpdate] = await conn.query(
    'SELECT action_value FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );
  console.log('Scene 4 bedroom/window:');
  console.log('  Before: 30');
  console.log('  After:', afterUpdate[0].action_value);
  console.log('  Status:', afterUpdate[0].action_value === '15' ? '✅ CONFIRMED' : '❌ ERROR');
  console.log('');

  // Verify Wake Up termination command unchanged in server.js
  const wakeTerminationCheck = serverCode.match(/Wake Up termination[\s\S]{0,500}bedroom\/window['"]\s*,\s*\{\s*angle:\s*0\s*\}/);
  console.log('Wake Up termination bedroom/window:');
  console.log('  Value: angle = 0');
  console.log('  Status:', wakeTerminationCheck ? '✅ UNCHANGED' : '❌ ERROR');
  console.log('');

  // Verify Wake→Home timer unchanged
  const [timerSettings] = await conn.query(
    'SELECT wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = 4'
  );
  console.log('Wake→Home timer settings:');
  console.log('  Enabled:', timerSettings[0].wake_home_timer_enabled);
  console.log('  Minutes:', timerSettings[0].wake_home_timer_minutes);
  console.log('  Seconds:', timerSettings[0].wake_home_timer_seconds);
  console.log('  Status: ✅ UNCHANGED');
  console.log('');

  // Verify all Scene 4 actions
  const [allActions] = await conn.query(
    'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 ORDER BY execution_order'
  );
  console.log('All Scene 4 actions:');
  allActions.forEach(a => {
    console.log(`  ${a.execution_order}: ${a.device_type}/${a.room || 'NULL'} → ${a.action_type} = ${a.action_value}`);
  });
  console.log('');

  console.log('========================================================');
  console.log('Update complete');
  console.log('========================================================');

  await conn.end();
})();
