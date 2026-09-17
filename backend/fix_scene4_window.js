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
  console.log('  FIX #1: Update Scene 4 Window Angle');
  console.log('========================================================');
  console.log('');

  // Check current value
  const [before] = await conn.query(
    'SELECT action_value FROM scene_actions WHERE scene_id = 4 AND device_type = "window" AND room = "bedroom"'
  );
  console.log(`Before: bedroom/window angle = ${before[0]?.action_value || 'NOT FOUND'}`);

  // Update to 130 degrees
  await conn.query(
    'UPDATE scene_actions SET action_value = 130 WHERE scene_id = 4 AND device_type = "window" AND room = "bedroom"'
  );

  // Verify change
  const [after] = await conn.query(
    'SELECT action_value FROM scene_actions WHERE scene_id = 4 AND device_type = "window" AND room = "bedroom"'
  );
  console.log(`After: bedroom/window angle = ${after[0]?.action_value || 'NOT FOUND'}`);

  console.log('');
  console.log('✓ Scene 4 window angle updated to 130°');

  await conn.end();
})();
