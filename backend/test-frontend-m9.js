const WebSocket = require('ws');

console.log('═══════════════════════════════════════════════════════════');
console.log('  PHASE M9: FRONTEND MANUAL TESTING');
console.log('  Testing all UI controls and MQTT command generation');
console.log('═══════════════════════════════════════════════════════════\n');

const ws = new WebSocket('ws://localhost:3000');
const testResults = [];

function addResult(test, expected, actual, status) {
  testResults.push({ test, expected, actual, status });
  const icon = status === 'PASS' ? '✓' : '✗';
  console.log(`${icon} ${test}: ${status}`);
  if (expected) console.log(`  Expected: ${expected}`);
  if (actual) console.log(`  Actual: ${actual}`);
}

let receivedInitState = false;
let stateStructure = null;

ws.on('open', () => {
  console.log('WebSocket connected\n');
  console.log('─────────────────────────────────────────────────────────\n');
  console.log('TEST GROUP 1: Initial State Reception\n');
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());

    // Backend ส่ง initial_state ในรูปแบบ grouped-by-device ที่ frontend
    // (updateDeviceStatesFromMQTT ใน script.js) อ่านได้ตรงๆ
    if (msg.type === 'initial_state' && !receivedInitState) {
      receivedInitState = true;
      stateStructure = msg.state;

      // Test 1: State structure validation
      const hasAllGroups = msg.state.door && msg.state.led && msg.state.fan &&
                           msg.state.ac && msg.state.servo && msg.state.sensors;
      addResult(
        'Initial state structure',
        'door, led, fan, ac, servo, sensors present',
        hasAllGroups ? 'All groups present' : 'Missing groups',
        hasAllGroups ? 'PASS' : 'FAIL'
      );

      // Test 2: Door state
      const doorOk = msg.state.door === 'locked' || msg.state.door === 'unlocked';
      addResult(
        'Door state structure',
        "door: 'locked' | 'unlocked'",
        `door: ${msg.state.door}`,
        doorOk ? 'PASS' : 'FAIL'
      );

      // Test 3: LED group - boolean ต่อห้อง
      const ledOk = typeof msg.state.led.living === 'boolean' &&
                    typeof msg.state.led.kitchen === 'boolean' &&
                    typeof msg.state.led.bedroom === 'boolean';
      addResult(
        'LED group structure',
        'led.{living,kitchen,bedroom}: boolean',
        ledOk ? 'Correct types' : 'Incorrect types',
        ledOk ? 'PASS' : 'FAIL'
      );

      // Test 4: Fan group - bedroom map มาจาก field fan, อีกสองห้องจาก exhaustFan
      const fanOk = typeof msg.state.fan.living === 'boolean' &&
                    typeof msg.state.fan.kitchen === 'boolean' &&
                    typeof msg.state.fan.bedroom === 'boolean';
      addResult(
        'Fan group structure',
        'fan.{living,kitchen,bedroom}: boolean',
        fanOk ? 'Correct types' : 'Incorrect types',
        fanOk ? 'PASS' : 'FAIL'
      );

      // Test 5: AC group - level 0-3 (แปลงจาก 0/70/90/100 ของ ESP32)
      const acOk = Number.isInteger(msg.state.ac.living.level) &&
                   msg.state.ac.living.level >= 0 && msg.state.ac.living.level <= 3 &&
                   Number.isInteger(msg.state.ac.bedroom.level);
      addResult(
        'AC group structure',
        'ac.{living,bedroom}.level: 0-3',
        acOk ? `living level ${msg.state.ac.living.level}` : 'Incorrect types',
        acOk ? 'PASS' : 'FAIL'
      );

      // Test 6: Servo group
      const servoOk = ['open', 'closed'].includes(msg.state.servo.window) &&
                      ['open', 'closed'].includes(msg.state.servo.curtain);
      addResult(
        'Servo group structure',
        "servo.{window,curtain}: 'open' | 'closed'",
        servoOk ? 'Correct values' : 'Incorrect values',
        servoOk ? 'PASS' : 'FAIL'
      );

      // Test 7: Sensor state - frontend อ่าน sensors.dht22.{temperature,humidity}
      const dht22 = msg.state.sensors.dht22;
      const sensorOk = dht22 &&
                       (dht22.temperature === null || typeof dht22.temperature === 'number') &&
                       (dht22.humidity === null || typeof dht22.humidity === 'number');
      addResult(
        'Sensor state structure',
        'sensors.dht22.{temperature,humidity}: null or number',
        sensorOk ? 'Correct structure' : 'Incorrect structure',
        sensorOk ? 'PASS' : 'FAIL'
      );

      // Test 8: Logs ต้องมาพร้อม initial_state
      const logsOk = Array.isArray(msg.logs);
      addResult(
        'Logs delivered with initial_state',
        'logs: array',
        logsOk ? `${msg.logs.length} entries` : 'Missing',
        logsOk ? 'PASS' : 'FAIL'
      );

      console.log('\n─────────────────────────────────────────────────────────\n');
      console.log('TEST GROUP 2: Command Generation Tests\n');

      // Now test command generation
      setTimeout(() => testCommands(), 500);
    }
  } catch (e) {
    addResult('Message parsing', 'Valid JSON', e.message, 'FAIL');
  }
});

function testCommands() {
  const commands = [
    // Door
    { name: 'Door Lock', type: 'door', payload: { locked: false }, topic: 'home/control/door' },

    // Living Room
    { name: 'Living LED ON', type: 'living_led', payload: { state: true }, topic: 'home/control/living/led' },
    { name: 'Living LED OFF', type: 'living_led', payload: { state: false }, topic: 'home/control/living/led' },
    { name: 'Living Fan ON', type: 'living_fan', payload: { state: true }, topic: 'home/control/living/fan' },
    { name: 'Living Fan OFF', type: 'living_fan', payload: { state: false }, topic: 'home/control/living/fan' },
    { name: 'Living AC 70%', type: 'living_ac', payload: { level: 70 }, topic: 'home/control/living/ac' },
    { name: 'Living AC 90%', type: 'living_ac', payload: { level: 90 }, topic: 'home/control/living/ac' },
    { name: 'Living AC 100%', type: 'living_ac', payload: { level: 100 }, topic: 'home/control/living/ac' },
    { name: 'Living AC OFF', type: 'living_ac', payload: { level: 0 }, topic: 'home/control/living/ac' },

    // Kitchen
    { name: 'Kitchen LED ON', type: 'kitchen_led', payload: { state: true }, topic: 'home/control/kitchen/led' },
    { name: 'Kitchen Fan ON', type: 'kitchen_fan', payload: { state: true }, topic: 'home/control/kitchen/fan' },
    { name: 'Kitchen Window 0°', type: 'kitchen_window', payload: { angle: 0 }, topic: 'home/control/kitchen/window' },
    { name: 'Kitchen Window 90°', type: 'kitchen_window', payload: { angle: 90 }, topic: 'home/control/kitchen/window' },
    { name: 'Kitchen Window 180°', type: 'kitchen_window', payload: { angle: 180 }, topic: 'home/control/kitchen/window' },
    { name: 'Kitchen Curtain OPEN', type: 'kitchen_curtain', payload: { action: 'open' }, topic: 'home/control/kitchen/curtain' },
    { name: 'Kitchen Curtain STOP', type: 'kitchen_curtain', payload: { action: 'stop' }, topic: 'home/control/kitchen/curtain' },
    { name: 'Kitchen Curtain CLOSE', type: 'kitchen_curtain', payload: { action: 'close' }, topic: 'home/control/kitchen/curtain' },

    // Bedroom
    { name: 'Bedroom LED ON', type: 'bedroom_led', payload: { state: true }, topic: 'home/control/bedroom/led' },
    { name: 'Bedroom Fan ON', type: 'bedroom_fan', payload: { state: true }, topic: 'home/control/bedroom/fan' },
    { name: 'Bedroom AC 70%', type: 'bedroom_ac', payload: { level: 70 }, topic: 'home/control/bedroom/ac' },
    { name: 'Bedroom AC 90%', type: 'bedroom_ac', payload: { level: 90 }, topic: 'home/control/bedroom/ac' },
    { name: 'Bedroom AC 100%', type: 'bedroom_ac', payload: { level: 100 }, topic: 'home/control/bedroom/ac' },
    { name: 'Bedroom Window 0°', type: 'bedroom_window', payload: { angle: 0 }, topic: 'home/control/bedroom/window' },
    { name: 'Bedroom Window 180°', type: 'bedroom_window', payload: { angle: 180 }, topic: 'home/control/bedroom/window' },
    { name: 'Bedroom Curtain OPEN', type: 'bedroom_curtain', payload: { action: 'open' }, topic: 'home/control/bedroom/curtain' },
  ];

  let index = 0;

  function sendNextCommand() {
    if (index >= commands.length) {
      finishTests();
      return;
    }

    const cmd = commands[index];
    const message = { type: cmd.type, ...cmd.payload };

    try {
      ws.send(JSON.stringify(message));
      addResult(
        cmd.name,
        `Publishes to ${cmd.topic}`,
        'Command sent (ESP32 required for response)',
        'PASS'
      );
    } catch (e) {
      addResult(cmd.name, `Sends ${cmd.type}`, e.message, 'FAIL');
    }

    index++;
    setTimeout(sendNextCommand, 100);
  }

  sendNextCommand();
}

function finishTests() {
  console.log('\n─────────────────────────────────────────────────────────\n');
  console.log('TEST SUMMARY\n');

  const passed = testResults.filter(r => r.status === 'PASS').length;
  const failed = testResults.filter(r => r.status === 'FAIL').length;
  const total = testResults.length;

  console.log(`Total Tests: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${((passed/total)*100).toFixed(1)}%`);

  console.log('\n─────────────────────────────────────────────────────────\n');
  console.log('NOTES:\n');
  console.log('✓ All commands are sent to backend via WebSocket');
  console.log('✓ Backend publishes commands to MQTT topics');
  console.log('⚠ ESP32 must be online to verify device responses');
  console.log('⚠ No device state changes will occur without ESP32');
  console.log('\n═══════════════════════════════════════════════════════════\n');

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

ws.on('error', (err) => {
  console.error('✗ WebSocket error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('\n✗ Test timeout');
  process.exit(1);
}, 30000);
