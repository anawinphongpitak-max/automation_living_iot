-- Phase 7B-4: Add Wake Up → Home timer columns
ALTER TABLE scenes
ADD COLUMN wake_home_timer_enabled TINYINT(1) DEFAULT 1 COMMENT 'Whether wake-to-home timer is enabled',
ADD COLUMN wake_home_timer_minutes INT DEFAULT 0 COMMENT 'Wake-to-home timer duration in minutes',
ADD COLUMN wake_home_timer_seconds INT DEFAULT 30 COMMENT 'Wake-to-home timer duration in seconds (0-59)';
