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
  console.log('  MIGRATION: Add Auto Mode OFF to Scene 4 (Wake Up)');
  console.log('========================================================');
  console.log('');

  // Check if auto_mode action already exists in Scene 4
  const [existing] = await conn.query(
    'SELECT id FROM scene_actions WHERE scene_id = 4 AND device_type = "auto_mode"'
  );

  if (existing.length > 0) {
    console.log('Auto Mode action already exists in Scene 4 - skipping migration');
    await conn.end();
    return;
  }

  // Add Auto Mode OFF action to Scene 4 at execution_order 0 (before other actions)
  // This ensures Auto Mode is disabled BEFORE bedroom devices are turned ON
  await conn.query(
    'UPDATE scene_actions SET execution_order = execution_order + 1 WHERE scene_id = 4'
  );
  console.log('Shifted existing Scene 4 actions: execution_order + 1');

  await conn.query(
    'INSERT INTO scene_actions (scene_id, device_type, room, action_type, action_value, execution_order) VALUES (?, ?, ?, ?, ?, ?)',
    [4, 'auto_mode', null, 'mode', 'off', 0]
  );
  console.log('Added Auto Mode OFF action to Scene 4 at execution_order 0');

  console.log('');
  console.log('Scene 4 Actions (after migration):');
  const [actions] = await conn.query(
    'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 ORDER BY execution_order'
  );
  actions.forEach(a => {
    console.log(`  ${a.execution_order}: ${a.device_type}/${a.room || 'NULL'} → ${a.action_type} = ${a.action_value}`);
  });

  console.log('');
  console.log('Migration complete');
  await conn.end();
})();
