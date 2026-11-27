const mysql = require('./backend/node_modules/mysql2/promise');
const bcrypt = require('./backend/node_modules/bcrypt');

// Manually load environment from Railway
process.env.DB_HOST = 'monorail.proxy.rlwy.net';
process.env.DB_PORT = '57855';
process.env.DB_USER = 'root';
process.env.DB_PASSWORD = 'bvbJtHiMqPWpYpzquSfoMDcIajbecBhk';
process.env.DB_NAME = 'railway';

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  console.log('Querying admin user from Railway database...');
  const [rows] = await pool.execute(
    'SELECT id, username, email, role, active, password_hash FROM web_users WHERE username = ?',
    ['admin']
  );

  if (rows.length === 0) {
    console.log('ERROR: No admin user found');
    await pool.end();
    return;
  }

  const user = rows[0];
  console.log('\nUser found:');
  console.log('  ID:', user.id);
  console.log('  Username:', user.username);
  console.log('  Email:', user.email);
  console.log('  Role:', user.role);
  console.log('  Active:', user.active);
  console.log('  Hash exists:', user.password_hash ? 'YES' : 'NO');
  console.log('  Hash length:', user.password_hash ? user.password_hash.length : 0);
  console.log('  Hash prefix:', user.password_hash ? user.password_hash.substring(0, 7) : 'null');

  console.log('\nTesting password verification...');
  const testPassword = 'admin123';
  const match = await bcrypt.compare(testPassword, user.password_hash);
  console.log('Password "admin123" matches:', match);

  await pool.end();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
