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

  console.log('Scene 4 Wake Up Timer - Current Database Values:');
  const [scene4] = await conn.query(
    'SELECT id, name, wake_home_timer_enabled, wake_home_timer_minutes, wake_home_timer_seconds FROM scenes WHERE id = 4'
  );

  if (scene4.length > 0) {
    const s = scene4[0];
    console.log(`  ID: ${s.id}`);
    console.log(`  Name: ${s.name}`);
    console.log(`  wake_home_timer_enabled: ${s.wake_home_timer_enabled}`);
    console.log(`  wake_home_timer_minutes: ${s.wake_home_timer_minutes}`);
    console.log(`  wake_home_timer_seconds: ${s.wake_home_timer_seconds}`);
  } else {
    console.log('  Scene 4 not found');
  }

  await conn.end();
})();
