/* =====================================================
   FRONTEND DEBUG CONFIGURATION
   ===================================================== */

// Set to true for development debugging
// Set to false for production/normal use to minimize console output
const FRONTEND_DEBUG = false;

// Conditional logging helpers
const debugLog = FRONTEND_DEBUG ? console.log.bind(console) : () => {};
const debugInfo = FRONTEND_DEBUG ? console.info.bind(console) : () => {};
const debugWarn = FRONTEND_DEBUG ? console.warn.bind(console) : () => {};

// Always allow errors, but sanitize them
const debugError = console.error.bind(console);
