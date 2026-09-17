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
  console.log('  INSPECTION: Current Bedroom Window State');
  console.log('========================================================');
  console.log('');

  // Query Scene 4 bedroom window action
  console.log('TASK 1 - Scene 4 Bedroom Window Action:');
  const [scene4Window] = await conn.query(
    'SELECT id, scene_id, device_type, room, action_type, action_value, execution_order FROM scene_actions WHERE scene_id = 4 AND device_type = ? AND room = ?',
    ['window', 'bedroom']
  );

  if (scene4Window.length > 0) {
    console.log('  Database: scenes.scene_actions');
    console.log('  Scene ID: 4 (Wake Up)');
    console.log('  Device: bedroom/window');
    console.log('  Action type:', scene4Window[0].action_type);
    console.log('  Current value:', scene4Window[0].action_value);
    console.log('  Execution order:', scene4Window[0].execution_order);
  } else {
    console.log('  ERROR: Scene 4 bedroom window action not found');
  }
  console.log('');

  console.log('  Target value: 115');
  console.log('  Change required: YES');
  console.log('');

  await conn.end();
})();
