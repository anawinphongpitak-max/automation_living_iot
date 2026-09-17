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

  console.log('Scene action counts:');
  const [counts] = await conn.query('SELECT scene_id, COUNT(*) AS cnt FROM scene_actions GROUP BY scene_id ORDER BY scene_id');
  const [total] = await conn.query('SELECT COUNT(*) as total FROM scene_actions');

  counts.forEach(c => {
    const name = c.scene_id === 2 ? 'Home' : c.scene_id === 3 ? 'Sleep' : c.scene_id === 4 ? 'Wake Up' : c.scene_id === 5 ? 'Exit' : 'Unknown';
    console.log(`  Scene ${c.scene_id} (${name}): ${c.cnt} actions`);
  });
  console.log(`  Total: ${total[0].total} actions`);
  console.log('');

  const [autoMode] = await conn.query("SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 3 AND device_type = 'auto_mode'");

  if (autoMode.length > 0) {
    const a = autoMode[0];
    console.log('Sleep auto_mode action: FOUND');
    console.log(`  device_type: ${a.device_type}`);
    console.log(`  room: ${a.room || 'NULL'}`);
    console.log(`  action_type: ${a.action_type}`);
    console.log(`  action_value: ${a.action_value}`);
    console.log(`  execution_order: ${a.execution_order}`);
  } else {
    console.log('Sleep auto_mode action: NOT FOUND - CRITICAL ERROR');
  }

  await conn.end();
})();
