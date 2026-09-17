const WebSocket = require('ws');

console.log('=== WebSocket Test ===');
console.log('Connecting to ws://localhost:3000...\n');

const ws = new WebSocket('ws://localhost:3000');

let testsPassed = 0;
let testsFailed = 0;

ws.on('open', () => {
  console.log('✓ WebSocket connected');
  testsPassed++;
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log(`\n← Received: ${msg.type}`);

    if (msg.type === 'initial_state') {
      console.log('✓ initial_state received');
      console.log(`  - Door: ${msg.state.door}`);
      console.log(`  - Living LED: ${msg.state.led.living}`);
      console.log(`  - Kitchen Window: ${msg.state.servo.window}`);
      console.log(`  - Bedroom AC level: ${msg.state.ac.bedroom.level}`);
      console.log(`  - MQTT Online: ${msg.state.system.mqtt}`);
      console.log(`  - Logs: ${msg.logs.length} entries`);
      testsPassed++;

      // Test sending a command
      console.log('\n→ Sending test command: living_led ON');
      ws.send(JSON.stringify({ type: 'living_led', state: true }));

      setTimeout(() => {
        console.log('\n→ Sending test command: kitchen_window 90°');
        ws.send(JSON.stringify({ type: 'kitchen_window', angle: 90 }));

        setTimeout(() => {
          console.log('\n=== Test Summary ===');
          console.log(`Passed: ${testsPassed}`);
          console.log(`Failed: ${testsFailed}`);
          console.log('\nNote: Commands sent to MQTT. ESP32 needs to be online to see responses.');
          ws.close();
          process.exit(0);
        }, 2000);
      }, 2000);
    } else if (msg.type === 'mqtt_status') {
      console.log(`✓ MQTT status: ${msg.connected ? 'Connected' : 'Disconnected'}`);
      testsPassed++;
    } else {
      console.log(`  Data: ${JSON.stringify(msg).substring(0, 100)}`);
    }
  } catch (e) {
    console.error('✗ Failed to parse message:', e.message);
    testsFailed++;
  }
});

ws.on('error', (err) => {
  console.error('✗ WebSocket error:', err.message);
  testsFailed++;
  process.exit(1);
});

ws.on('close', () => {
  console.log('\nWebSocket closed');
});

setTimeout(() => {
  console.error('\n✗ Test timeout (10s)');
  process.exit(1);
}, 10000);
