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
  console.log('  UPDATE Scene 4 Bedroom Window Action');
  console.log('========================================================');
  console.log('');

  // STEP 1: Query current value
  console.log('STEP 1: Query current Scene 4 bedroom/window action');
  const [before] = await conn.query(
    'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );

  if (before.length === 0) {
    console.log('ERROR: Scene 4 bedroom/window action not found');
    await conn.end();
    return;
  }

  console.log('Current action:');
  console.log(`  id: ${before[0].id}`);
  console.log(`  scene_id: ${before[0].scene_id}`);
  console.log(`  device_type: ${before[0].device_type}`);
  console.log(`  room: ${before[0].room}`);
  console.log(`  action_type: ${before[0].action_type}`);
  console.log(`  action_value: ${before[0].action_value}`);
  console.log(`  execution_order: ${before[0].execution_order}`);
  console.log('');

  // STEP 2: Confirm current value is 0
  if (before[0].action_value !== '130') {
    console.log(`WARNING: Current action_value is "${before[0].action_value}", not "130" as expected`);
  } else {
    console.log('CONFIRMED: Current action_value = 130');
  }
  console.log('');

  // STEP 3: Update to 30
  console.log('STEP 3: Updating action_value from 130 to 30');
  const [updateResult] = await conn.query(
    'UPDATE scene_actions SET action_value = ? WHERE id = ?',
    ['30', before[0].id]
  );
  console.log(`Rows affected: ${updateResult.affectedRows}`);
  console.log('');

  // STEP 4: Query again to confirm
  console.log('STEP 4: Query updated action to confirm change');
  const [after] = await conn.query(
    'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );

  console.log('Updated action:');
  console.log(`  id: ${after[0].id}`);
  console.log(`  scene_id: ${after[0].scene_id}`);
  console.log(`  device_type: ${after[0].device_type}`);
  console.log(`  room: ${after[0].room}`);
  console.log(`  action_type: ${after[0].action_type}`);
  console.log(`  action_value: ${after[0].action_value}`);
  console.log(`  execution_order: ${after[0].execution_order}`);
  console.log('');

  if (after[0].action_value === '30') {
    console.log('✅ CONFIRMED: action_value = 30');
  } else {
    console.log(`❌ ERROR: action_value = ${after[0].action_value}, expected 30`);
  }
  console.log('');

  // STEP 5: Verify no other Scene 4 actions changed
  console.log('STEP 5: Verify all Scene 4 actions');
  const [allActions] = await conn.query(
    'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 ORDER BY execution_order'
  );

  allActions.forEach(a => {
    console.log(`  ${a.execution_order}: ${a.device_type}/${a.room || 'NULL'} → ${a.action_type} = ${a.action_value}`);
  });
  console.log('');

  // STEP 6: Verify Wake→Home timer unchanged
  console.log('STEP 6: Verify Scene 4 timer settings');
  const [scene4] = await conn.query(
    'SELECT wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = 4'
  );
  console.log(`  wake_home_timer_enabled: ${scene4[0].wake_home_timer_enabled}`);
  console.log(`  wake_home_timer_minutes: ${scene4[0].wake_home_timer_minutes}`);
  console.log(`  wake_home_timer_seconds: ${scene4[0].wake_home_timer_seconds}`);
  console.log('');

  console.log('========================================================');
  console.log('Update complete');
  console.log('========================================================');

  await conn.end();
})();
