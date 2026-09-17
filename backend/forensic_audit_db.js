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
  console.log('  LIVE DATABASE STATE - SCENE 4 (WAKE UP)');
  console.log('========================================================');
  console.log('');

  const [scene4] = await conn.query(
    'SELECT id, name, wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = 4'
  );

  if (scene4.length > 0) {
    const s = scene4[0];
    console.log(`Scene: ${s.name} (ID: ${s.id})`);
    console.log(`Wake→Home Timer: enabled=${s.wake_home_timer_enabled}, minutes=${s.wake_home_timer_minutes}, seconds=${s.wake_home_timer_seconds}`);
  }
  console.log('');

  console.log('Scene 4 Actions:');
  const [actions4] = await conn.query(
    'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 ORDER BY execution_order'
  );
  actions4.forEach(a => {
    console.log(`  ${a.execution_order}: ${a.device_type}/${a.room || 'NULL'} → ${a.action_type} = ${a.action_value}`);
  });

  console.log('');
  console.log('========================================================');
  console.log('  LIVE DATABASE STATE - SCENE 2 (HOME)');
  console.log('========================================================');
  console.log('');

  const [scene2] = await conn.query(
    'SELECT id, name FROM scenes WHERE id = 2'
  );

  if (scene2.length > 0) {
    console.log(`Scene: ${scene2[0].name} (ID: ${scene2[0].id})`);
  }
  console.log('');

  console.log('Scene 2 Actions:');
  const [actions2] = await conn.query(
    'SELECT device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 2 ORDER BY execution_order'
  );
  actions2.forEach(a => {
    console.log(`  ${a.execution_order}: ${a.device_type}/${a.room || 'NULL'} → ${a.action_type} = ${a.action_value}`);
  });

  await conn.end();
})();
