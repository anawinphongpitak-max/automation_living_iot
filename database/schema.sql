-- =====================================================
-- Smart Home IoT Event History Database Schema
-- =====================================================

-- Create database if not exists
CREATE DATABASE IF NOT EXISTS smart_home_iot
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- Use database
USE smart_home_iot;

-- Create event_history table
CREATE TABLE IF NOT EXISTS event_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  -- Event Classification
  event_type VARCHAR(50) NOT NULL COMMENT 'Event category: MOTION, DEVICE_CONTROL, SCENE_CHANGE, AUTO_ACTION, SYSTEM_EVENT, etc.',

  -- Event Context
  room VARCHAR(50) COMMENT 'Room name: living, kitchen, bedroom',
  device VARCHAR(100) COMMENT 'Device type: LED, Fan, AC, Window, Curtain, Door, PIR, etc.',

  -- Event Data
  message VARCHAR(255) NOT NULL COMMENT 'Human-readable event description',
  details TEXT COMMENT 'Additional event metadata in JSON format',

  -- Timestamp
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Event timestamp',

  -- Indexes for query performance
  INDEX idx_event_type (event_type),
  INDEX idx_created_at (created_at),
  INDEX idx_room (room),
  INDEX idx_type_created (event_type, created_at)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Smart Home event history and activity log';

-- Create fingerprint_users table
CREATE TABLE IF NOT EXISTS fingerprint_users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  -- Fingerprint ID from AS608 sensor
  fingerprint_id INT UNSIGNED NOT NULL UNIQUE COMMENT 'Fingerprint ID stored in AS608 sensor (1-127)',

  -- User Information
  name VARCHAR(100) NOT NULL COMMENT 'User display name',
  role ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER' COMMENT 'User role: ADMIN or USER',

  -- Timestamp
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation timestamp',

  -- Indexes
  INDEX idx_fingerprint_id (fingerprint_id),
  INDEX idx_role (role)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Fingerprint user registry with role mapping';

-- Insert initial ADMIN record for Fingerprint ID 1
INSERT IGNORE INTO fingerprint_users (fingerprint_id, name, role)
VALUES (1, 'Administrator', 'ADMIN');

-- =====================================================
-- WEB LOGIN SYSTEM
-- Independent from the AS608 fingerprint_users table.
-- fingerprint_users  = physical door access / fingerprint ADMIN authorization
-- web_users          = Web Dashboard login accounts (username/email + password)
-- These two systems are intentionally separate.
-- =====================================================

CREATE TABLE IF NOT EXISTS web_users (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- Login identifiers
  username VARCHAR(50) NOT NULL UNIQUE COMMENT 'Login username',
  email VARCHAR(100) NOT NULL UNIQUE COMMENT 'Login email address',

  -- Credentials (bcrypt hash only - never plaintext)
  password_hash VARCHAR(255) NOT NULL COMMENT 'Bcrypt password hash',

  -- Account information
  full_name VARCHAR(100) COMMENT 'Display name',
  role ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER' COMMENT 'Web dashboard role: ADMIN or USER',

  -- Timestamps / state
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'Account creation timestamp',
  last_login TIMESTAMP NULL COMMENT 'Last successful login timestamp',
  active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 = active account, 0 = disabled',

  -- Indexes
  INDEX idx_username (username),
  INDEX idx_email (email)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Web Dashboard login accounts (separate from fingerprint_users)';

-- NOTE: No initial admin account is inserted here.
-- An initial admin must be created with a real bcrypt password hash
-- once a password has been explicitly chosen (Phase 2+).

-- =====================================================
-- SCENE CRUD SYSTEM
-- Persistent storage for user-created and system Scenes.
-- =====================================================

-- Create scenes table
CREATE TABLE IF NOT EXISTS scenes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  -- Scene Information
  name VARCHAR(100) NOT NULL COMMENT 'Scene display name',
  description VARCHAR(255) COMMENT 'Optional scene description',
  icon VARCHAR(255) COMMENT 'Material Symbols icon HTML',
  is_system TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0 = user-created, 1 = built-in system scene',

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Scene creation timestamp',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Scene last update timestamp',

  -- Sleep Timer Configuration
  timer_enabled TINYINT(1) DEFAULT 0 COMMENT 'Whether sleep timer is enabled',
  timer_minutes INT DEFAULT 0 COMMENT 'Timer duration in minutes',
  timer_seconds INT DEFAULT 0 COMMENT 'Timer duration in seconds (0-59)',

  -- Wake Up → Home Timer Configuration
  wake_home_timer_enabled TINYINT(1) DEFAULT 0 COMMENT 'Whether wake-to-home timer is enabled',
  wake_home_timer_minutes INT DEFAULT 0 COMMENT 'Wake-to-home timer duration in minutes',
  wake_home_timer_seconds INT DEFAULT 0 COMMENT 'Wake-to-home timer duration in seconds (0-59)',

  -- Indexes
  INDEX idx_is_system (is_system),
  INDEX idx_created_at (created_at)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Scene definitions for automation routines';

-- Create scene_actions table
CREATE TABLE IF NOT EXISTS scene_actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  -- Scene Reference
  scene_id BIGINT UNSIGNED NOT NULL COMMENT 'Foreign key to scenes table',

  -- Action Details
  device_type VARCHAR(50) NOT NULL COMMENT 'Device type: led, fan, ac, window, door, auto_mode',
  room VARCHAR(50) COMMENT 'Target room: living, kitchen, bedroom, or NULL for global actions',
  action_type VARCHAR(50) NOT NULL COMMENT 'Action type: state, level, angle, mode',
  action_value VARCHAR(255) NOT NULL COMMENT 'Action value or JSON payload',

  -- Execution
  execution_order INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Order in which actions execute (0-based)',

  -- Timestamp
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Action creation timestamp',

  -- Foreign Key Constraint
  CONSTRAINT fk_scene_actions_scene_id
    FOREIGN KEY (scene_id)
    REFERENCES scenes(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  -- Indexes
  INDEX idx_scene_id (scene_id),
  INDEX idx_execution_order (execution_order),
  INDEX idx_scene_order (scene_id, execution_order)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Actions associated with each scene';

