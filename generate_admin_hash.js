#!/usr/bin/env node
/**
 * Secure bcrypt hash generator for first web ADMIN user
 *
 * Usage:
 *   node generate_admin_hash.js
 *
 * This script:
 * - Prompts for password via terminal (hidden input)
 * - Generates bcrypt hash with cost 10
 * - Displays hash for manual database INSERT
 * - Does NOT store password or hash to disk
 */

const bcrypt = require('bcrypt');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Hide password input
function askPassword(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (char) => {
      char = char.toString();
      switch (char) {
        case "\n":
        case "\r":
        case "":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          break;
        case "":
          process.exit();
          break;
        case "": // Backspace
          password = password.slice(0, -1);
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write(query);
          break;
        default:
          password += char;
          break;
      }
    };

    let password = '';
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('Web Admin User - Bcrypt Hash Generator');
  console.log('='.repeat(60));
  console.log('');
  console.log('Requirements:');
  console.log('  - Minimum 8 characters');
  console.log('  - Recommended: 12+ characters, mixed case, numbers, symbols');
  console.log('');

  try {
    const password = await askPassword('Enter password for first ADMIN user: ');

    // Validate password
    if (!password || password.length < 8) {
      console.error('\n✗ Password must be at least 8 characters');
      process.exit(1);
    }

    console.log('');
    console.log('Generating bcrypt hash (cost: 10)...');

    // Generate hash with cost 10
    const hash = await bcrypt.hash(password, 10);

    // Validate hash format
    if (hash.length !== 60 || !hash.startsWith('$2')) {
      console.error('✗ Hash generation failed - invalid format');
      process.exit(1);
    }

    console.log('✓ Hash generated successfully');
    console.log('');
    console.log('='.repeat(60));
    console.log('COPY THIS HASH FOR DATABASE INSERT');
    console.log('='.repeat(60));
    console.log('');
    console.log(hash);
    console.log('');
    console.log('='.repeat(60));
    console.log('');
    console.log('SQL INSERT statement:');
    console.log('');
    console.log("INSERT INTO web_users");
    console.log("  (username, email, password_hash, full_name, role, active)");
    console.log("VALUES");
    console.log("  ('admin',");
    console.log("   'admin@localhost',");
    console.log(`   '${hash}',`);
    console.log("   'Administrator',");
    console.log("   'ADMIN',");
    console.log("   1);");
    console.log('');
    console.log('='.repeat(60));
    console.log('');
    console.log('IMPORTANT:');
    console.log('  - Save this SQL statement securely');
    console.log('  - Do NOT commit to Git');
    console.log('  - Execute via Railway MySQL connection');
    console.log('  - Change username/email as needed');
    console.log('');

  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
