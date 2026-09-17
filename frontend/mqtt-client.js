/* =====================================================
   MQTT CLIENT FOR FRONTEND
   เชื่อมต่อกับ Backend ผ่าน WebSocket
===================================================== */

class MQTTClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 3000;
    this.listeners = {};
    this.intentionalDisconnect = false;
  }

  connect() {
    debugLog('[MQTT Client] Connecting to backend...');
    this.intentionalDisconnect = false; // Reset flag on intentional reconnect

    // เชื่อมต่อกับ Backend WebSocket - dynamic origin for Railway deployment
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.ws = new WebSocket(`${protocol}//${host}`);

    this.ws.onopen = () => {
      debugLog('[MQTT Client] Connected to backend!');
      this.connected = true;
      this.emit('connected');

      // Clear reconnect timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // SECURITY: Do not log raw MQTT payloads - may contain sensitive data
        debugLog('[MQTT Client] Message received:', data.type);

        // Handle different message types
        if (data.type === 'initial_state') {
          this.emit('initial_state', data.state, data.logs);
        }
        else if (data.type === 'mqtt_message') {
          this.emit('message', data.topic, data.payload);
          this.emit('topic:' + data.topic, data.payload);
        }
        else if (data.type === 'state_update') {
          // Handle state updates from backend
          this.emit('state_update', data.state);
        }
        else if (data.type === 'debug_log') {
          this.emit('debug_log', data.data);
        }
        else if (data.type === 'scene_changed') {
          this.emit('scene_changed', data.scene);
        }
        else if (data.type) {
          // Handle all other typed events (fingerprint admin, enrollment, deletion, etc.)
          this.emit(data.type, data);
        }
      } catch (error) {
        console.error('[MQTT Client] Parse error:', error.message);
      }
    };

    this.ws.onclose = () => {
      debugLog('[MQTT Client] Disconnected');
      this.connected = false;
      this.emit('disconnected');

      // Don't auto-reconnect if disconnect was intentional (logout/session expired)
      if (this.intentionalDisconnect) {
        debugLog('[MQTT Client] Intentional disconnect - not reconnecting');
        return;
      }

      // Auto reconnect for unexpected disconnections
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    };

    this.ws.onerror = (error) => {
      console.error('[MQTT Client] Connection error');
    };
  }

  // Event emitter
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, ...args) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(...args));
    }
  }

  // Send command via HTTP API
  async sendCommand(topic, payload) {
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ topic, payload })
      });

      const result = await response.json();
      debugLog('[MQTT Client] Command sent');
      return result;
    } catch (error) {
      console.error('[MQTT Client] Send command error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Control methods - ใช้ API endpoints แทน
  async controlLED(room, state) {
    try {
      const response = await fetch(`/api/led/${room}/${state}`, {
        method: 'POST'
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] LED control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async controlFan(room, state) {
    try {
      const response = await fetch(`/api/fan/${room}/${state}`, {
        method: 'POST'
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] Fan control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async controlAC(room, level) {
    try {
      const response = await fetch(`/api/ac/${room}/${level}`, {
        method: 'POST'
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] AC control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async controlServo(device, action) {
    try {
      const response = await fetch(`/api/servo/${device}/${action}`, {
        method: 'POST'
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] Servo control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async controlDoor(command) {
    try {
      const response = await fetch(`/api/door/${command}`, {
        method: 'POST'
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] Door control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async setScene(scene) {
    try {
      const response = await fetch(`/api/scene/${scene}`, {
        method: 'POST'
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] Scene control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async setAutoMode(command) {
    debugLog('[AUTO DEBUG] mqttClient.setAutoMode() called with command:', command);
    try {
      const url = `/api/auto/${command}`;
      debugLog('[AUTO DEBUG] fetch ->', url);
      const response = await fetch(url, {
        method: 'POST'
      });
      debugLog('[AUTO DEBUG] HTTP status:', response.status);
      const json = await response.json();
      debugLog('[AUTO DEBUG] response body:', json);
      return json;
    } catch (error) {
      debugError('[AUTO DEBUG] setAutoMode fetch THREW:', error.message);
      console.error('[MQTT Client] Auto mode control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async setAutoSettings(lightFanTimeout, acTimeout) {
    try {
      const response = await fetch('/api/auto/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lightFanTimeout, acTimeout })
      });
      return await response.json();
    } catch (error) {
      console.error('[MQTT Client] Auto settings control error:', error.message);
      return { success: false, error: error.message };
    }
  }

  disconnect() {
    debugLog('[MQTT Client] Intentional disconnect');
    this.intentionalDisconnect = true;
    if (this.ws) {
      this.ws.close();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// Export instance
const mqttClient = new MQTTClient();
