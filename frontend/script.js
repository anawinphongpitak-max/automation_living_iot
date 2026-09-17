/* =====================================================
   SMART HOME DASHBOARD DEMO
   FRONTEND ONLY
===================================================== */


let currentPage = "dashboard";

let currentRoom = "living";

let currentDashboardRoom = "living";

let isInRoomDetail = false;

let failedAttempts = 0;

let activeScene = "home";

// สถานะประตู - locked มาจาก home/status/door ที่ ESP32 publish กลับ
// unlockTimer/unlockSecondsLeft ใช้กับการนับถอยหลัง 5 วินาทีก่อนล็อคอัตโนมัติ
let doorState = {
    locked: true,
    unlockTimer: null,
    unlockSecondsLeft: 0
};

const DOOR_UNLOCK_SECONDS = 5;

// โหมดควบคุม - manual = สั่งเองจาก dashboard, automation = ESP32 ตัดสินใจ
// จาก PIR/sensor เอง (ยิงผ่าน /api/auto/:command) ค่าจริงมาจาก backend
// ทาง initial_state.system.autoMode
let autoMode = false;

// ค่า timeout ของ Automatic Mode - หน่วยวินาที ค่าจริงมาจาก ESP32 เท่านั้น
// (home/status/auto/settings ผ่าน backend) ไม่ใช่ค่าที่ผู้ใช้กรอกแล้วยังไม่ยืนยัน
let autoSettings = {
    lightFanTimeout: null,
    acTimeout: null
};

// ห้องที่เคยได้รับ home/status/{room} แล้ว - ครั้งแรกถือเป็นการ sync สถานะ
// ไม่ใช่การเปลี่ยน จึงไม่ต้องขึ้น log (ค่า seed ใน rooms เป็นค่าสมมติ)
const syncedRooms = {};

let systemStatus = {
    esp32: false,  // ✅ ตั้งเป็น false จนกว่าจะได้รับสถานะจริง
    mqtt: false,   // ✅ ตั้งเป็น false จนกว่าจะเชื่อมต่อ
    mysql: false,
    telegram: false
};

// Sleep Timer State
let sleepTimerState = {
    active: false,
    endTime: null,
    updateInterval: null
};

// สถานะ PIR จริงแบบ real-time จาก home/status/pir (แยกจาก log motion เดิม)
let pirStatus = {
    living: false,
    kitchen: false,
    bedroom: false
};

let sensorData = {
    temperature: 0,
    humidity: 0,
    lastUpdate: null,
    temperatureHistory: [],
    humidityHistory: [],
    maxHistorySize: 20
};

let spotifyLoggedIn = false;
let spotifyAccessToken = null;
let currentTrack = null;
let isPlaying = false;
let progressInterval = null;
let spotifyPlayerMinimized = false;

// ========================================
// Spotify Configuration
// ========================================

const SPOTIFY_CLIENT_ID = "8dc5441bc4b0418291af83403e02e71f";
const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:5500/";
const SPOTIFY_SCOPES = "user-read-currently-playing user-modify-playback-state user-read-playback-state";

// ========================================
// Spotify PKCE Authentication
// ========================================

function generateRandomString(length) {
    const possible =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    const values = crypto.getRandomValues(
        new Uint8Array(length)
    );

    return Array.from(values)
        .map(x => possible[x % possible.length])
        .join("");
}


async function sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);

    return window.crypto.subtle.digest(
        "SHA-256",
        data
    );
}


function base64encode(input) {
    return btoa(
        String.fromCharCode(
            ...new Uint8Array(input)
        )
    )
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

async function getSpotifyAccessToken(code) {
    const codeVerifier = localStorage.getItem("spotify_code_verifier");

    if (!codeVerifier) {
        console.error("ไม่พบ spotify_code_verifier");
        return null;
    }

    const response = await fetch(
        "https://accounts.spotify.com/api/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                client_id: SPOTIFY_CLIENT_ID,
                grant_type: "authorization_code",
                code: code,
                redirect_uri: SPOTIFY_REDIRECT_URI,
                code_verifier: codeVerifier
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error("Spotify Token Error:", data.error || 'Token request failed');
        return null;
    }

    // SECURITY: Don't log access token details
    debugLog("Spotify Access Token received!");

    localStorage.setItem(
        "spotify_access_token",
        data.access_token
    );

    localStorage.setItem(
        "spotify_refresh_token",
        data.refresh_token
    );

    localStorage.setItem(
        "spotify_token_expires_at",
        Date.now() + data.expires_in * 1000
    );

    return data.access_token;
}

// ========================================
// 4. Handle Spotify Callback
// ========================================

async function handleSpotifyCallback() {

    const params =
        new URLSearchParams(window.location.search);

    const code = params.get("code");

    if (!code) {
        return;
    }

    console.log(
        "Spotify Authorization Code received!"
    );

    const accessToken =
        await getSpotifyAccessToken(code);

    if (!accessToken) {
        console.error(
            "ไม่สามารถรับ Access Token ได้"
        );
        return;
    }

    console.log(
        "Spotify connected successfully!"
    );

    // Update login status
    spotifyLoggedIn = true;
    spotifyAccessToken = accessToken;

    // ลบ ?code=xxxx ออกจาก URL
    window.history.replaceState(
        {},
        document.title,
        window.location.pathname
    );

    // Refresh page to show media controls
    renderPage();
}

// ========================================
// 5. Get Currently Playing
// ========================================

async function connectSpotify() {

    // Generate PKCE verifier
    const codeVerifier = generateRandomString(64);

    // Generate challenge
    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64encode(hashed);

    // Save verifier for later
    localStorage.setItem(
        "spotify_code_verifier",
        codeVerifier
    );

    // Spotify authorization URL
    const authUrl =
        new URL("https://accounts.spotify.com/authorize");

    const params = {
        response_type: "code",
        client_id: SPOTIFY_CLIENT_ID,
        scope: SPOTIFY_SCOPES,
        code_challenge_method: "S256",
        code_challenge: codeChallenge,
        redirect_uri: SPOTIFY_REDIRECT_URI
    };

    authUrl.search =
        new URLSearchParams(params).toString();

    // Go to Spotify Login
    window.location.href = authUrl.toString();
}

async function getCurrentlyPlaying() {

    const accessToken =
        localStorage.getItem(
            "spotify_access_token"
        );

    if (!accessToken) {
        console.log("Spotify ยังไม่ได้เชื่อมต่อ");
        return null;
    }

    try {

        const response = await fetch(
            "https://api.spotify.com/v1/me/player/currently-playing",
            {
                method: "GET",
                headers: {
                    Authorization:
                        `Bearer ${accessToken}`
                }
            }
        );

        if (response.status === 204) {
            console.log(
                "🎵 ตอนนี้ไม่มีเพลงกำลังเล่น"
            );
            currentTrack = null;
            isPlaying = false;
            return null;
        }

        if (response.status === 401) {
            console.log(
                "Spotify Access Token หมดอายุ"
            );
            spotifyLogout();
            return null;
        }

        if (!response.ok) {
            console.error(
                "Currently Playing Error:",
                response.status
            );
            return null;
        }

        const data = await response.json();

        currentTrack = {
            name: data.item?.name || "Unknown Track",
            artist: data.item?.artists?.map(a => a.name).join(", ") || "Unknown Artist",
            album: data.item?.album?.name || "Unknown Album",
            albumArt: data.item?.album?.images?.[0]?.url || null,
            duration: data.item?.duration_ms || 0,
            progress: data.progress_ms || 0
        };

        isPlaying = data.is_playing || false;

        console.log("🎵 Currently Playing:", currentTrack);

        return currentTrack;

    } catch (error) {

        console.error(
            "Spotify API Error:",
            error
        );

        return null;

    }
}

async function spotifyPlayPause() {
    const accessToken = localStorage.getItem("spotify_access_token");
    if (!accessToken) return;

    const endpoint = isPlaying
        ? "https://api.spotify.com/v1/me/player/pause"
        : "https://api.spotify.com/v1/me/player/play";

    try {
        const response = await fetch(endpoint, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        if (response.status === 204 || response.status === 202) {
            isPlaying = !isPlaying;

            // Start or stop progress update based on playing state
            if (isPlaying) {
                startProgressUpdate();
            } else {
                stopProgressUpdate();
            }

            // Update UI immediately
            updateMiniPlayer();
            if (currentPage === 'dashboard') {
                renderPage();
            }

            // Fetch updated state from API
            setTimeout(() => {
                getCurrentlyPlaying();
            }, 300);
        } else {
            console.error("Play/Pause failed:", response.status);
        }
    } catch (error) {
        console.error("Play/Pause Error:", error);
    }
}

async function spotifyNext() {
    const accessToken = localStorage.getItem("spotify_access_token");
    if (!accessToken) return;

    try {
        const response = await fetch("https://api.spotify.com/v1/me/player/next", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        if (response.status === 204 || response.status === 202) {
            // Stop current progress
            stopProgressUpdate();

            // Wait for track to change then update
            setTimeout(async () => {
                await getCurrentlyPlaying();
                updateMiniPlayer();
                if (currentPage === 'dashboard') {
                    renderPage();
                }
            }, 500);
        } else {
            console.error("Next failed:", response.status);
        }
    } catch (error) {
        console.error("Next Error:", error);
    }
}

async function spotifyPrevious() {
    const accessToken = localStorage.getItem("spotify_access_token");
    if (!accessToken) return;

    try {
        const response = await fetch("https://api.spotify.com/v1/me/player/previous", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        if (response.status === 204 || response.status === 202) {
            // Stop current progress
            stopProgressUpdate();

            // Wait for track to change then update
            setTimeout(async () => {
                await getCurrentlyPlaying();
                updateMiniPlayer();
                if (currentPage === 'dashboard') {
                    renderPage();
                }
            }, 500);
        } else {
            console.error("Previous failed:", response.status);
        }
    } catch (error) {
        console.error("Previous Error:", error);
    }
}

function spotifyLogout() {
    localStorage.removeItem("spotify_access_token");
    localStorage.removeItem("spotify_refresh_token");
    localStorage.removeItem("spotify_token_expires_at");
    localStorage.removeItem("spotify_code_verifier");

    spotifyLoggedIn = false;
    spotifyAccessToken = null;
    currentTrack = null;
    isPlaying = false;

    renderPage();
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function startProgressUpdate() {
    // Clear existing interval
    if (progressInterval) {
        clearInterval(progressInterval);
    }

    // Update progress every 1 second
    progressInterval = setInterval(() => {
        if (isPlaying && currentTrack && currentTrack.progress < currentTrack.duration) {
            currentTrack.progress += 1000; // Add 1 second

            // Update main media control progress bar
            const progressFill = document.querySelector('.progress-fill');
            const progressTime = document.querySelector('.media-progress small:first-child');

            if (progressFill && currentTrack.duration > 0) {
                const percentage = (currentTrack.progress / currentTrack.duration) * 100;
                progressFill.style.width = `${percentage}%`;
            }

            if (progressTime) {
                progressTime.textContent = formatTime(currentTrack.progress);
            }

            // Update mini player progress bar and time
            updateMiniProgress();

            const progressCurrent = document.getElementById('progress-current');
            if (progressCurrent) {
                progressCurrent.textContent = formatTime(currentTrack.progress);
            }
        }
    }, 1000);
}

function stopProgressUpdate() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}

function updateMiniPlayer() {
    const miniPlayBtn = document.getElementById('mini-play-btn');
    const dockTrackName = document.getElementById('dock-track-name');
    const dockTrackArtist = document.getElementById('dock-track-artist');
    const dockAlbumArt = document.getElementById('dock-album-art');
    const miniProgress = document.getElementById('mini-progress');
    const progressCurrent = document.getElementById('progress-current');
    const progressDuration = document.getElementById('progress-duration');

    if (spotifyLoggedIn && currentTrack) {
        // Update dock user info to show track info
        if (dockTrackName) {
            dockTrackName.textContent = currentTrack.name;
        }
        if (dockTrackArtist) {
            dockTrackArtist.innerHTML = `<span class="material-symbols-outlined" style="font-size: 12px;">person</span> ${currentTrack.artist}`;
        }
        if (dockAlbumArt) {
            if (currentTrack.albumArt) {
                dockAlbumArt.style.backgroundImage = `url('${currentTrack.albumArt}')`;
                dockAlbumArt.style.backgroundSize = 'cover';
                dockAlbumArt.style.backgroundPosition = 'center';
                dockAlbumArt.textContent = '';
            } else {
                dockAlbumArt.style.backgroundImage = 'none';
                dockAlbumArt.textContent = '♪';
            }
        }

        // Update play/pause icon
        if (miniPlayBtn) {
            const icon = miniPlayBtn.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = isPlaying ? 'pause' : 'play_arrow';
            }
        }

        // Update time displays
        if (progressCurrent) {
            progressCurrent.textContent = formatTime(currentTrack.progress);
        }
        if (progressDuration) {
            progressDuration.textContent = formatTime(currentTrack.duration);
        }

        // Update mini progress bar
        updateMiniProgress();

        // Show progress bar
        if (miniProgress) {
            miniProgress.style.display = 'block';
        }

    } else if (spotifyLoggedIn && !currentTrack) {
        // Logged in but no track
        if (dockTrackName) dockTrackName.textContent = 'No Track';
        if (dockTrackArtist) dockTrackArtist.innerHTML = `<i class="online-dot"></i> Spotify Connected`;
        if (dockAlbumArt) {
            dockAlbumArt.style.backgroundImage = 'none';
            dockAlbumArt.textContent = 'A';
        }
        if (progressCurrent) progressCurrent.textContent = '0:00';
        if (progressDuration) progressDuration.textContent = '0:00';
        if (miniProgress) miniProgress.style.display = 'none';

    } else {
        // Not logged in - show default
        if (dockTrackName) dockTrackName.textContent = 'Admin';
        if (dockTrackArtist) dockTrackArtist.innerHTML = `<i class="online-dot"></i> Online`;
        if (dockAlbumArt) {
            dockAlbumArt.style.backgroundImage = 'none';
            dockAlbumArt.textContent = 'A';
        }
        if (progressCurrent) progressCurrent.textContent = '0:00';
        if (progressDuration) progressDuration.textContent = '0:00';
        if (miniProgress) miniProgress.style.display = 'none';
    }

    // Update the minimized Spotify player if it's active
    updateSpotifyMiniPlayer();
}

function updateMiniProgress() {
    const miniProgressFill = document.querySelector('.mini-progress-fill');

    if (miniProgressFill && currentTrack && currentTrack.duration > 0) {
        const percentage = (currentTrack.progress / currentTrack.duration) * 100;
        miniProgressFill.style.width = `${Math.min(percentage, 100)}%`;
    }
}

/* =====================================================
   DEMO DATA
===================================================== */

const rooms = {

    living: {

        name: "Living Room",

        icon: '<span class="material-symbols-outlined">weekend</span>',

        devices: {

            ac: {
                name: "Air Conditioner",
                type: "ac",
                state: true,
                level: 2
            },

            exhaust: {
                name: "Exhaust Fan",
                type: "fan",
                state: false
            },

            light: {
                name: "Light",
                type: "light",
                state: true
            }

        }

    },


    kitchen: {

        name: "Kitchen",

        icon: '<span class="material-symbols-outlined">kitchen</span>',

        devices: {

            exhaust: {
                name: "Exhaust Fan",
                type: "fan",
                state: true
            },

            light: {
                name: "Light",
                type: "light",
                state: false
            },

            window: {
                name: "Window",
                type: "servo",
                state: "closed"
            }

        }

    },


    bedroom: {

        name: "Bedroom",

        icon: '<span class="material-symbols-outlined">bed</span>',

        devices: {

            ac: {
                name: "Air Conditioner",
                type: "ac",
                state: true,
                level: 1
            },

            fan: {
                name: "Fan",
                type: "fan",
                state: true
            },

            light: {
                name: "Light",
                type: "light",
                state: true
            },

            window: {
                name: "Window",
                type: "servo",
                state: "closed"
            }

        }

    }

};


// Legacy scene definitions for backward compatibility and fallback
const scenesLegacy = [

    {
        id: "home",
        name: "Home Mode",
        icon: '<span class="material-symbols-outlined">home</span>',
        actions: 5
    },

    {
        id: "sleep",
        name: "Sleep Mode",
        icon: '<span class="material-symbols-outlined">bedtime</span>',
        actions: 6
    },

    {
        id: "wake",
        name: "Wake Up",
        icon: '<span class="material-symbols-outlined">wb_sunny</span>',
        actions: 5
    },

    {
        id: "exit",
        name: "Exit Mode",
        icon: '<span class="material-symbols-outlined">logout</span>',
        actions: 7
    },

    {
        id: "cooking",
        name: "Cooking",
        icon: '<span class="material-symbols-outlined">kitchen</span>',
        actions: 4
    }

];

// Active scenes array - will be populated from API
let scenes = [...scenesLegacy];

// Map database scene IDs to legacy scene keys for execution compatibility
const sceneIdToLegacyKey = {
    2: 'home',    // Home Mode
    3: 'sleep',   // Sleep Mode
    4: 'wake',    // Wake Up
    5: 'exit'     // Exit Mode
};

// Reverse map for looking up database IDs
const legacyKeyToSceneId = {
    'home': 2,
    'sleep': 3,
    'wake': 4,
    'exit': 5
};


const fingerprints = [

    {
        id: 1,
        name: "Admin",
        rank: "Administrator",
        status: "Active"
    },

    {
        id: 2,
        name: "User 01",
        rank: "User",
        status: "Active"
    },

    {
        id: 3,
        name: "User 02",
        rank: "User",
        status: "Active"
    }

];


// เริ่มจากว่าง แล้วเติมด้วย event จริงจาก addLog() (MQTT + การกดปุ่ม)
let logs = [];

// ESP32 Automatic Mode debug telemetry (home/debug/log ผ่าน MQTT -> WS debug_log)
// Ring buffer แยกจาก logs เดิมทั้งหมด - ไม่กระทบ addLog()/renderLogs()
const MAX_DEBUG_LOGS = 100;
let debugLogs = [];


let history = [

    {
        time: "19:31",
        room: "Living Room",
        event: "Fingerprint Success",
        user: "Admin"
    },

    {
        time: "19:30",
        room: "Living Room",
        event: "Light ON",
        user: "Admin"
    },

    {
        time: "19:29",
        room: "Kitchen",
        event: "Motion Detected",
        user: "System"
    }

];


/* =====================================================
   WEB AUTHENTICATION
===================================================== */

let webAuthenticated = false;
let currentUserRole = null;

/**
 * Centralized web-session expiration handling.
 * Only for expired/invalid web sessions - NOT for normal logout,
 * network failure, MQTT failure, or ESP32 offline.
 */
function handleSessionExpired() {
    // Guard: prevents repeated processing when several protected
    // requests (e.g. fingerprint admin status polling) 401 at once
    if (!webAuthenticated) return;

    webAuthenticated = false;
    currentUserRole = null;

    // Close the dashboard WebSocket intentionally (stops auto-reconnect)
    if (typeof mqttClient !== 'undefined' && mqttClient) {
        mqttClient.disconnect();
    }

    showLogin();

    const passwordInput = document.getElementById('login-password');
    if (passwordInput) passwordInput.value = '';

    const errorDiv = document.getElementById('login-error');
    if (errorDiv) {
        errorDiv.textContent = 'Session expired. Please log in again.';
        errorDiv.style.display = 'block';
    }
}

/**
 * fetch() wrapper that detects an expired web session.
 * Only protected local /api/* routes trigger expiration handling.
 * /api/auth/* and external requests are deliberately excluded.
 */
async function authenticatedFetch(url, options = {}) {
    const response = await fetch(url, options);

    if (response.status === 401 && typeof url === 'string') {
        // Normalize so both '/api/x' and 'http://localhost:3000/api/x' are covered,
        // while external hosts (e.g. Spotify) are never treated as session expiry.
        let path = null;
        if (url.startsWith('/')) {
            path = url;
        } else {
            try {
                const parsed = new URL(url, window.location.origin);
                if (parsed.origin === window.location.origin) {
                    path = parsed.pathname;
                }
            } catch (err) {
                path = null;
            }
        }

        if (path && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
            handleSessionExpired();
        }
    }

    return response;
}

async function checkWebSession() {
    try {
        const response = await fetch('/api/auth/session', {
            credentials: 'same-origin'
        });
        const data = await response.json();

        if (data.authenticated === true) {
            currentUserRole = data.user && data.user.role ? data.user.role : null;
            return true;
        }

        currentUserRole = null;
        return false;
    } catch (err) {
        console.error('[AUTH] Session check failed:', err.message);
        currentUserRole = null;
        return false;
    }
}

/**
 * Show the User Management nav item for ADMIN sessions only.
 * This is presentation only - the backend independently enforces
 * ADMIN authorization on every /api/users endpoint.
 */
function applyRoleBasedUI() {
    const navUsers = document.getElementById('nav-users');
    if (!navUsers) return;

    if (currentUserRole === 'ADMIN') {
        navUsers.style.display = '';
    } else {
        navUsers.style.display = 'none';
        // If a non-admin somehow sits on the users page, send them home
        if (currentPage === 'users') {
            currentPage = 'dashboard';
        }
    }
}

async function handleLogin(event) {
    event.preventDefault();

    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const submitButton = document.getElementById('login-submit');
    const errorDiv = document.getElementById('login-error');
    const buttonText = document.getElementById('login-button-text');
    const buttonLoading = document.getElementById('login-button-loading');

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    // Clear previous error
    errorDiv.style.display = 'none';
    errorDiv.textContent = '';

    // Show loading state
    submitButton.disabled = true;
    buttonText.style.display = 'none';
    buttonLoading.style.display = 'inline';

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, password })
        });

        if (response.ok) {
            // Login successful
            const data = await response.json();
            webAuthenticated = true;
            currentUserRole = data.user && data.user.role ? data.user.role : null;
            passwordInput.value = '';
            showDashboard();
            applyRoleBasedUI();
            initializeAuthenticatedDashboard();
        } else {
            // Login failed
            const data = await response.json();
            errorDiv.textContent = data.message || 'Invalid username/email or password.';
            errorDiv.style.display = 'block';
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (err) {
        console.error('[AUTH] Login error:', err.message);
        errorDiv.textContent = 'Unable to connect to the server. Please try again.';
        errorDiv.style.display = 'block';
    } finally {
        // Reset button state
        submitButton.disabled = false;
        buttonText.style.display = 'inline';
        buttonLoading.style.display = 'none';
    }
}

async function handleLogout() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin'
        });

        webAuthenticated = false;
        currentUserRole = null;

        // Close the dashboard WebSocket intentionally so it does not reconnect
        if (typeof mqttClient !== 'undefined' && mqttClient) {
            mqttClient.disconnect();
        }

        showLogin();

        // Clear password input
        const passwordInput = document.getElementById('login-password');
        if (passwordInput) passwordInput.value = '';

        // Clear any login errors
        const errorDiv = document.getElementById('login-error');
        if (errorDiv) {
            errorDiv.style.display = 'none';
            errorDiv.textContent = '';
        }

    } catch (err) {
        console.error('[AUTH] Logout error:', err.message);
    }
}

function showLogin() {
    const loginScreen = document.getElementById('login-screen');
    const appDashboard = document.getElementById('app-dashboard');
    const floatingDock = document.querySelector('.floating-dock');

    if (loginScreen) loginScreen.classList.remove('auth-hidden');
    if (appDashboard) appDashboard.classList.add('auth-hidden');
    if (floatingDock) floatingDock.classList.add('auth-hidden');
}

function showDashboard() {
    const loginScreen = document.getElementById('login-screen');
    const appDashboard = document.getElementById('app-dashboard');
    const floatingDock = document.querySelector('.floating-dock');

    if (loginScreen) loginScreen.classList.add('auth-hidden');
    if (appDashboard) appDashboard.classList.remove('auth-hidden');
    if (floatingDock) floatingDock.classList.remove('auth-hidden');
}

let dashboardInitialized = false;

function initializeAuthenticatedDashboard() {
    if (dashboardInitialized) return;
    dashboardInitialized = true;

    // Connect to MQTT Backend
    setupMQTTConnection();

    renderPage();

    // Update Spotify track every 5 seconds if logged in
    setInterval(async () => {
        if (spotifyLoggedIn && webAuthenticated) {
            await getCurrentlyPlaying();
            if (currentPage === 'dashboard') {
                renderPage();
            }
        }
    }, 5000);
}


/* =====================================================
   INITIALIZE
===================================================== */

document.addEventListener("DOMContentLoaded", async () => {

    // Apply saved theme before checking session
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-mode');
    }

    // Check for Spotify callback
    await handleSpotifyCallback();

    // Check if already logged in (Spotify)
    const savedToken = localStorage.getItem("spotify_access_token");
    const expiresAt = localStorage.getItem("spotify_token_expires_at");

    if (savedToken && expiresAt && Date.now() < parseInt(expiresAt)) {
        spotifyLoggedIn = true;
        spotifyAccessToken = savedToken;
        await getCurrentlyPlaying();
    }

    // Setup navigation and theme
    setupNavigation();
    setupThemeToggle();
    setupModeToggle();
    setupSpotifyMiniPlayerListeners();

    // Setup login form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    // Setup logout button
    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.addEventListener('click', openLogoutModal);
    }

    // Check web authentication session
    const isAuthenticated = await checkWebSession();

    if (isAuthenticated) {
        webAuthenticated = true;
        showDashboard();
        applyRoleBasedUI();
        initializeAuthenticatedDashboard();
    } else {
        webAuthenticated = false;
        showLogin();
    }

});


/* =====================================================
   THEME TOGGLE
===================================================== */

function setupThemeToggle() {

    const themeToggle = document.getElementById('themeToggle');

    // ตรวจสอบธีมจากระบบ
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // ตรวจสอบธีมที่บันทึกไว้ใน localStorage
    const savedTheme = localStorage.getItem('theme');

    // ถ้ามีธีมที่บันทึกไว้ ใช้ของที่บันทึก ไม่งั้นใช้ตามระบบ
    if (savedTheme === 'light' || (!savedTheme && !prefersDark)) {
        document.body.classList.add('light-mode');
        themeToggle.innerHTML = '<span class="material-symbols-outlined">light_mode</span>';
    }

    // Event listener สำหรับปุ่ม toggle
    themeToggle.addEventListener('click', () => {
        document.body.classList.toggle('light-mode');

        if (document.body.classList.contains('light-mode')) {
            themeToggle.innerHTML = '<span class="material-symbols-outlined">light_mode</span>';
            localStorage.setItem('theme', 'light');
        } else {
            themeToggle.innerHTML = '<span class="material-symbols-outlined">dark_mode</span>';
            localStorage.setItem('theme', 'dark');
        }
    });

    // ฟังการเปลี่ยนแปลงธีมจากระบบ
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        // ถ้าไม่มีการตั้งค่าเอง ให้เปลี่ยนตามระบบ
        if (!localStorage.getItem('theme')) {
            if (e.matches) {
                document.body.classList.remove('light-mode');
                themeToggle.innerHTML = '<span class="material-symbols-outlined">dark_mode</span>';
            } else {
                document.body.classList.add('light-mode');
                themeToggle.innerHTML = '<span class="material-symbols-outlined">light_mode</span>';
            }
        }
    });

}


/* =====================================================
   MODE TOGGLE (Manual / Automation)
===================================================== */

function setupModeToggle() {

    const modeToggle = document.getElementById('modeToggle');
    if (!modeToggle) {
        debugError('[AUTO DEBUG] #modeToggle element NOT FOUND in DOM - listener not attached');
        return;
    }
    debugLog('[AUTO DEBUG] #modeToggle found, attaching click listener');

    renderModeToggle();

    modeToggle.addEventListener('click', async () => {

        debugLog('[AUTO DEBUG] Button clicked');

        const next = !autoMode;
        const modeStr = next ? 'on' : 'off';

        debugLog('[AUTO DEBUG] Sending mode:', modeStr);

        // กันกดรัวระหว่างรอ backend ตอบ
        modeToggle.disabled = true;

        debugLog('[AUTO DEBUG] API request starting -> POST /api/auto/' + modeStr);
        const result = await mqttClient.setAutoMode(modeStr);
        debugLog('[AUTO DEBUG] POST response received:', result);

        modeToggle.disabled = false;

        if (!result || result.success === false) {
            debugError('[AUTO DEBUG] Mode switch FAILED:', result && result.error);
            showToast('❌ สลับโหมดไม่สำเร็จ');
            return;
        }

        autoMode = next;
        renderModeToggle();

        showToast(autoMode
            ? '🤖 Automation Mode - ระบบทำงานอัตโนมัติ'
            : '✋ Manual Mode - ควบคุมด้วยตัวเอง');

        addLog(
            null,
            `Switched to ${autoMode ? 'AUTOMATION' : 'MANUAL'} mode`,
            `<span class="material-symbols-outlined">${autoMode ? 'smart_toy' : 'pan_tool'}</span>`
        );
    });
}


/**
 * วาดหน้าตาปุ่มตามค่า autoMode ปัจจุบัน
 * เรียกได้ทั้งตอนกดเองและตอนได้ค่าจาก backend
 */
function renderModeToggle() {

    const modeToggle = document.getElementById('modeToggle');
    if (!modeToggle) return;

    modeToggle.classList.toggle('auto', autoMode);
    modeToggle.innerHTML = `
        <span class="material-symbols-outlined">${autoMode ? 'smart_toy' : 'pan_tool'}</span>
        <span class="mode-label">${autoMode ? 'AUTO' : 'MANUAL'}</span>
    `;
    modeToggle.title = autoMode
        ? 'Automation Mode - กดเพื่อสลับไป Manual'
        : 'Manual Mode - กดเพื่อสลับไป Automation';
}


/* =====================================================
   HELPER FUNCTIONS FOR SMART HOME OVERVIEW
===================================================== */

function getActiveDeviceCount() {
    let count = 0;
    for (let roomKey in rooms) {
        const room = rooms[roomKey];
        for (let deviceKey in room.devices) {
            const device = room.devices[deviceKey];
            if (device.state === true || (device.type === 'ac' && device.level > 0)) {
                count++;
            }
        }
    }
    return count;
}

function getTotalDeviceCount() {
    let count = 0;
    for (let roomKey in rooms) {
        const room = rooms[roomKey];
        count += Object.keys(room.devices).length;
    }
    return count;
}

function activateQuickScene(sceneId) {
    // เดิม local-only demo - เปลี่ยนให้เรียก pipeline จริงตัวเดียวกับปุ่มใน
    // หน้า Scenes (runScene) กันไม่ให้มี logic เปิด/ปิดอุปกรณ์ซ้ำสองที่
    runScene(sceneId);
}


/* =====================================================
   NAVIGATION
===================================================== */

function setupNavigation() {

    document
        .querySelectorAll(".nav-item")
        .forEach(button => {

            button.addEventListener("click", () => {

                currentPage =
                    button.dataset.page;

                document
                    .querySelectorAll(".nav-item")
                    .forEach(item =>
                        item.classList.remove("active")
                    );

                button.classList.add("active");

                renderPage();

            });

        });

}


function renderPage() {

    const content =
        document.getElementById(
            "page-content"
        );

    const title =
        document.getElementById(
            "breadcrumb-title"
        );


    const pageNames = {

        dashboard: "Dashboard",

        rooms: "Rooms",

        scenes: "Scene Mode",

        fingerprint: "Fingerprint",

        history: "History",

        telegram: "Telegram",

        settings: "Settings",

        users: "User Management"

    };


    title.textContent =
        pageNames[currentPage];


    // Stop dashboard updates when leaving dashboard page
    if (currentPage !== 'dashboard') {
        stopDashboardUpdates();
    }


    switch (currentPage) {

        case "dashboard":
            content.innerHTML =
                dashboardHTML();
            // Start real-time updates for dashboard
            startDashboardUpdates();
            break;

        case "rooms":
            // Check if we're in room detail mode
            if (isInRoomDetail && currentRoom) {
                content.innerHTML =
                    roomDetailHTML(currentRoom);
            } else {
                content.innerHTML =
                    roomsHTML();
            }
            break;

        case "scenes":
            // Show loading state
            content.innerHTML = `
                <div class="page-header">
                    <div>
                        <div class="eyebrow">AUTOMATION</div>
                        <h1>Scene Mode</h1>
                        <p class="subtitle">Loading scenes...</p>
                    </div>
                </div>
            `;
            // Load scenes from API then render
            loadScenes().then(() => {
                content.innerHTML = scenesHTML();
                bindDynamicButtons();
            }).catch(error => {
                console.error('Scene load error:', error);
                content.innerHTML = scenesHTML();
                bindDynamicButtons();
            });
            return; // Exit early, rendering handled in promise
            break;

        case "fingerprint":
            content.innerHTML =
                fingerprintHTML();
            // Load fingerprint users if admin is authorized
            if (window.adminAuthState && window.adminAuthState.authorized) {
                loadFingerprintUsers();
                startAdminCountdown();
            }
            break;

        case "history":
            content.innerHTML =
                historyHTML();
            loadHistory();
            break;

        case "telegram":
            // Load settings from backend before rendering
            loadTelegramSettings().then(() => {
                renderTelegramPage();
            });
            break;

        case "settings":
            content.innerHTML =
                settingsHTML();
            renderDebugConsole();
            break;

        case "users":
            content.innerHTML = usersHTML();
            loadUsers();
            break;

    }

    bindDynamicButtons();

}


/* =====================================================
   DASHBOARD
===================================================== */

function dashboardHTML() {

    debugLog('Dashboard loading... spotifyLoggedIn:', spotifyLoggedIn);

    // Get greeting based on current time
    const hour = new Date().getHours();
    let greeting = 'Good evening';
    if (hour >= 5 && hour < 12) {
        greeting = 'Good morning';
    } else if (hour >= 12 && hour < 18) {
        greeting = 'Good afternoon';
    }

    return `

        <div class="title-row">

            <div>

                <div class="eyebrow">
                    SMART HOME
                </div>

                <h1>
                    ${greeting}, Admin
                </h1>

                <p class="subtitle">
                    Your home is running smoothly.
                </p>

            </div>

            <div class="card" style="text-align: center;">
                <span class="material-symbols-outlined">schedule</span>
                <strong id="current-datetime">
                    ${new Date().toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })} · ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </strong>
            </div>

        </div>


        <div class="dashboard-grid">


            <!-- HERO -->

            <div class="card hero-card">

                <div class="overview-main">

                    <div class="overview-header">
                        <h2>SMART HOME OVERVIEW</h2>
                        <div class="system-status-badge">
                            <i class="online-dot"></i>
                            SYSTEM ONLINE
                        </div>
                    </div>

                    <div class="overview-stats">

                        <div class="stat-card">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">theater_comedy</span>
                            </div>
                            <div class="stat-content">
                                <small>CURRENT SCENE</small>
                                <strong>${scenes.find(s => s.id === activeScene)?.name || 'Home Mode'}</strong>
                                <span class="stat-badge active-badge">Active</span>
                            </div>
                        </div>

                        <div class="stat-card">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">devices</span>
                            </div>
                            <div class="stat-content">
                                <small>ACTIVE DEVICES</small>
                                <strong>${getActiveDeviceCount()} / ${getTotalDeviceCount()}</strong>
                                <span class="stat-badge">Devices Active</span>
                            </div>
                        </div>

                        <div class="stat-card">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">notifications</span>
                            </div>
                            <div class="stat-content">
                                <small>SYSTEM ALERTS</small>
                                <strong>0</strong>
                                <span class="stat-badge success-badge">No Issues</span>
                            </div>
                        </div>

                    </div>

                    <div class="system-connections">
                        <small>SYSTEM CONNECTIONS</small>
                        <div class="connection-grid">
                            <div class="connection-item ${systemStatus.esp32 ? 'connected' : 'disconnected'}">
                                <i class="online-dot"></i>
                                <span>ESP32</span>
                                <small>${systemStatus.esp32 ? 'Connected' : 'Offline'}</small>
                            </div>
                            <div class="connection-item ${systemStatus.mqtt ? 'connected' : 'disconnected'}">
                                <i class="online-dot"></i>
                                <span>MQTT</span>
                                <small>${systemStatus.mqtt ? 'Connected' : 'Offline'}</small>
                            </div>
                            <div class="connection-item ${systemStatus.mysql ? 'connected' : 'disconnected'}">
                                <i class="online-dot"></i>
                                <span>MySQL</span>
                                <small>${systemStatus.mysql ? 'Connected' : 'Offline'}</small>
                            </div>
                            <div class="connection-item ${systemStatus.telegram ? 'connected' : 'disconnected'}">
                                <i class="online-dot"></i>
                                <span>Telegram</span>
                                <small>${systemStatus.telegram ? 'Ready' : 'Offline'}</small>
                            </div>
                        </div>
                    </div>

                    <div class="system-connections pir-sensors">
                        <small><span class="material-symbols-outlined">directions_walk</span>PIR SENSORS</small>
                        <div class="connection-grid pir-grid">
                            ${pirRoomRowHTML('living', 'Living Room')}
                            ${pirRoomRowHTML('kitchen', 'Kitchen')}
                            ${pirRoomRowHTML('bedroom', 'Bedroom')}
                        </div>
                    </div>

                </div>

                <div class="overview-scenes">
                    <h3>QUICK SCENES</h3>
                    <div class="quick-scene-buttons">
                        ${scenes.slice(0, 4).map(scene => {
                            // Map scene IDs to scene names for comparison
                            const sceneNames = { 2: 'home', 3: 'sleep', 4: 'wakeup', 5: 'exit' };
                            const sceneName = sceneNames[scene.id] || scene.name.toLowerCase();
                            return `
                            <button
                                class="scene-quick-btn ${activeScene === sceneName ? 'active' : ''}"
                                onclick="activateQuickScene('${scene.id}')"
                            >
                                ${scene.icon}
                                <span>${scene.name}</span>
                            </button>
                        `;
                        }).join('')}
                    </div>
                </div>

            </div>


            <!-- DOOR LOCK -->

            ${doorLockCardHTML()}


            <!-- LIVING ROOM -->

            ${roomDashboardCard(currentDashboardRoom)}


            <!-- TEMPERATURE -->

            <div class="card sensor-card">

                <div class="card-title">

                    <span class="material-symbols-outlined">device_thermostat</span> Temperature

                    <span>
                        Real-time
                    </span>

                </div>

                <div
                    class="big-number"
                    id="dashboard-temperature"
                    style="font-size: 3rem; margin: 20px 0 15px 0;"
                >
                    <span class="sensor-value">${sensorData.temperature > 0 ? sensorData.temperature.toFixed(1) : '--'}</span><small style="font-size: 1.3rem;">°C</small>
                </div>

                <div style="display: flex; justify-content: space-around; margin-top: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <div style="text-align: center;">
                        <div style="font-size: 0.65rem; color: #666; margin-bottom: 4px;">MIN</div>
                        <div style="font-size: 1.1rem; color: #4ecdc4;" id="temp-min">${sensorData.temperatureHistory.length > 0 ? Math.min(...sensorData.temperatureHistory).toFixed(1) : '--'}</div>
                    </div>
                    <div style="text-align: center;">
                        <div style="font-size: 0.65rem; color: #666; margin-bottom: 4px;">AVG</div>
                        <div style="font-size: 1.1rem; color: #ffd93d;" id="temp-avg">${sensorData.temperatureHistory.length > 0 ? (sensorData.temperatureHistory.reduce((a,b)=>a+b,0)/sensorData.temperatureHistory.length).toFixed(1) : '--'}</div>
                    </div>
                    <div style="text-align: center;">
                        <div style="font-size: 0.65rem; color: #666; margin-bottom: 4px;">MAX</div>
                        <div style="font-size: 1.1rem; color: #ff6b6b;" id="temp-max">${sensorData.temperatureHistory.length > 0 ? Math.max(...sensorData.temperatureHistory).toFixed(1) : '--'}</div>
                    </div>
                </div>

            </div>


            <!-- HUMIDITY -->

            <div class="card sensor-card">

                <div class="card-title">

                    <span class="material-symbols-outlined">water_drop</span> Humidity

                    <span>
                        Real-time
                    </span>

                </div>

                <div
                    class="big-number"
                    id="dashboard-humidity"
                    style="font-size: 3rem; margin: 20px 0 15px 0;"
                >
                    <span class="sensor-value">${sensorData.humidity > 0 ? Math.round(sensorData.humidity) : '--'}</span><small style="font-size: 1.3rem;">%</small>
                </div>

                <div style="display: flex; justify-content: space-around; margin-top: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <div style="text-align: center;">
                        <div style="font-size: 0.65rem; color: #666; margin-bottom: 4px;">MIN</div>
                        <div style="font-size: 1.1rem; color: #4ecdc4;" id="humid-min">${sensorData.humidityHistory.length > 0 ? Math.round(Math.min(...sensorData.humidityHistory)) : '--'}</div>
                    </div>
                    <div style="text-align: center;">
                        <div style="font-size: 0.65rem; color: #666; margin-bottom: 4px;">AVG</div>
                        <div style="font-size: 1.1rem; color: #ffd93d;" id="humid-avg">${sensorData.humidityHistory.length > 0 ? Math.round(sensorData.humidityHistory.reduce((a,b)=>a+b,0)/sensorData.humidityHistory.length) : '--'}</div>
                    </div>
                    <div style="text-align: center;">
                        <div style="font-size: 0.65rem; color: #666; margin-bottom: 4px;">MAX</div>
                        <div style="font-size: 1.1rem; color: #ff6b6b;" id="humid-max">${sensorData.humidityHistory.length > 0 ? Math.round(Math.max(...sensorData.humidityHistory)) : '--'}</div>
                    </div>
                </div>

            </div>


            <!-- MEDIA CONTROL -->

            <div class="card media-control-card" id="spotify-main-player" style="${spotifyPlayerMinimized ? 'display: none;' : ''}">

                <div class="card-title">

                    <span class="material-symbols-outlined">music_note</span> Media Control

                    <div style="display: flex; gap: 8px; align-items: center;">
                        ${spotifyLoggedIn && currentTrack ? `
                            <button class="icon-button" onclick="minimizeSpotifyPlayer()" title="Minimize Player">
                                <span class="material-symbols-outlined">minimize</span>
                            </button>
                        ` : ''}
                        ${spotifyLoggedIn ? `
                            <button class="icon-button" onclick="spotifyLogout()" title="Logout">
                                <span class="material-symbols-outlined">logout</span>
                            </button>
                        ` : ''}
                    </div>

                </div>

                ${spotifyLoggedIn ? `

                    ${currentTrack ? `

                        <div class="media-info">
                            <div class="media-artwork" style="${currentTrack.albumArt ? `background-image: url('${currentTrack.albumArt}'); background-size: cover; background-position: center;` : ''}">
                                ${!currentTrack.albumArt ? '<span class="material-symbols-outlined">album</span>' : ''}
                            </div>
                            <div class="media-details">
                                <h3>${currentTrack.name}</h3>
                                <p>${currentTrack.artist}</p>
                                <small style="color: #666;">${currentTrack.album}</small>
                            </div>
                        </div>

                        <div class="media-controls">
                            <button class="media-btn" onclick="spotifyPrevious()">
                                <span class="material-symbols-outlined">skip_previous</span>
                            </button>
                            <button class="media-btn media-btn-play" onclick="spotifyPlayPause()">
                                <span class="material-symbols-outlined">${isPlaying ? 'pause' : 'play_arrow'}</span>
                            </button>
                            <button class="media-btn" onclick="spotifyNext()">
                                <span class="material-symbols-outlined">skip_next</span>
                            </button>
                        </div>

                        <div class="media-progress">
                            <small>${formatTime(currentTrack.progress)}</small>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${(currentTrack.progress / currentTrack.duration) * 100}%"></div>
                            </div>
                            <small>${formatTime(currentTrack.duration)}</small>
                        </div>

                    ` : `

                        <div class="spotify-login-prompt" style="min-height: 200px;">
                            <span class="material-symbols-outlined spotify-icon">music_off</span>
                            <h3>No Track Playing</h3>
                            <p>Play a song on Spotify to see it here</p>
                            <button class="secondary-button" onclick="getCurrentlyPlaying().then(() => renderPage())">
                                <span class="material-symbols-outlined">refresh</span>
                                REFRESH
                            </button>
                        </div>

                    `}

                ` : `

                    <div class="spotify-login-prompt">
                        <span class="material-symbols-outlined spotify-icon">library_music</span>
                        <h3>Connect Spotify</h3>
                        <p>Login to control your music playback</p>
                        <button class="primary-button" onclick="connectSpotify()">
                            <span class="material-symbols-outlined">login</span>
                            LOGIN WITH SPOTIFY
                        </button>
                    </div>

                `}

            </div>


            <!-- LIVE LOG -->

            <div class="card live-log-card">

                <div class="card-title">
                    <div>
                        <i class="online-dot"></i>
                        <span style="margin-left: 8px;">LIVE LOGS</span>
                    </div>
                    <small style="color: #4ee4c7;">REAL-TIME</small>
                </div>

                <div id="dashboard-log-container" style="margin-top: 15px;">
                    ${logItemsHTML()}
                </div>

            </div>

        </div>

    `;
}


/* =====================================================
   PIR SENSORS (SMART HOME OVERVIEW)
   สถานะจริงจาก home/status/pir - แยกจาก log motion เดิม
   (home/sensor/pir/* ที่ยังทำงานเหมือนเดิมทุกอย่าง ไม่แตะ)
===================================================== */

function pirRoomRowHTML(room, label) {

    const active = !!pirStatus[room];

    return `
        <div class="pir-room ${active ? 'pir-motion' : 'pir-clear'}" data-pir-room="${room}">
            <div class="pir-room-name">
                <i class="online-dot"></i>
                <span>${label}</span>
            </div>
            <small>${active ? 'MOTION DETECTED' : 'CLEAR'}</small>
        </div>
    `;
}

function updatePIRStatusUI() {

    if (currentPage !== 'dashboard') return;

    const grid = document.querySelector('.pir-grid');
    if (!grid) return;

    grid.innerHTML = `
        ${pirRoomRowHTML('living', 'Living Room')}
        ${pirRoomRowHTML('kitchen', 'Kitchen')}
        ${pirRoomRowHTML('bedroom', 'Bedroom')}
    `;
}


/* =====================================================
   DOOR LOCK CARD
===================================================== */

function doorLockCardHTML() {

    const unlocked = !doorState.locked;
    const counting = doorState.unlockSecondsLeft > 0;

    return `

        <div class="card door-lock-card">

            <div class="card-title">
                <div>
                    <span class="material-symbols-outlined">meeting_room</span>
                    <span style="margin-left: 8px;">DOOR LOCK</span>
                </div>
                <small style="color: ${unlocked ? '#ffd93d' : '#4ee4c7'};">
                    ${unlocked ? 'UNLOCKED' : 'SECURED'}
                </small>
            </div>

            <div class="door-lock-body">

                <div class="door-lock-icon ${unlocked ? 'unlocked' : ''}" id="door-icon">
                    <span class="material-symbols-outlined">
                        ${unlocked ? 'lock_open' : 'lock'}
                    </span>
                </div>

                <div class="door-lock-status" id="door-status">
                    ${counting
                        ? `<strong class="door-countdown">${doorState.unlockSecondsLeft}</strong>
                           <small>วินาที ก่อนล็อคอัตโนมัติ</small>`
                        : `<strong>${unlocked ? 'ประตูปลดล็อคแล้ว' : 'ประตูล็อคอยู่'}</strong>
                           <small>Main Door</small>`}
                </div>

                <button
                    class="door-unlock-btn ${counting ? 'counting' : ''}"
                    id="door-unlock-btn"
                    onclick="unlockDoor()"
                    ${counting ? 'disabled' : ''}
                >
                    <span class="material-symbols-outlined">
                        ${counting ? 'timer' : 'lock_open'}
                    </span>
                    ${counting ? `กำลังปลดล็อค (${doorState.unlockSecondsLeft})` : 'ปลดล็อคประตู'}
                </button>

            </div>

        </div>

    `;
}


/**
 * ปลดล็อคประตู แล้วนับถอยหลัง 5 วินาทีก่อนสั่งล็อคกลับอัตโนมัติ
 * ถ้ากดซ้ำระหว่างนับ จะไม่ทำอะไร (ปุ่มถูก disable ไว้แล้ว)
 */
async function unlockDoor() {

    if (doorState.unlockTimer) return;

    const result = await mqttClient.controlDoor('unlock');

    if (result && result.success === false) {
        showToast('❌ ปลดล็อคไม่สำเร็จ');
        addLog(null, 'Door unlock failed', '<span class="material-symbols-outlined">error</span>');
        return;
    }

    doorState.locked = false;
    doorState.unlockSecondsLeft = DOOR_UNLOCK_SECONDS;

    showToast('🔓 ปลดล็อคประตูแล้ว');
    addLog(null, 'Door UNLOCKED', '<span class="material-symbols-outlined">lock_open</span>');

    refreshDoorCard();

    doorState.unlockTimer = setInterval(async () => {

        doorState.unlockSecondsLeft--;

        if (doorState.unlockSecondsLeft > 0) {
            refreshDoorCard();
            return;
        }

        // หมดเวลา - ล็อคกลับ
        clearInterval(doorState.unlockTimer);
        doorState.unlockTimer = null;

        await mqttClient.controlDoor('lock');

        doorState.locked = true;
        showToast('🔒 ล็อคประตูอัตโนมัติ');
        addLog(null, 'Door LOCKED (auto)', '<span class="material-symbols-outlined">lock</span>');

        refreshDoorCard();

    }, 1000);
}


/**
 * วาดการ์ดประตูใหม่เฉพาะจุด ไม่ re-render ทั้งหน้า
 * (renderPage() จะทำให้ Spotify/log กระพริบและ interval ถูกตั้งใหม่)
 */
function refreshDoorCard() {

    if (currentPage !== 'dashboard') return;

    const card = document.querySelector('.door-lock-card');
    if (!card) return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = doorLockCardHTML().trim();

    card.replaceWith(wrapper.firstElementChild);
}

/*
 * ค่า timeout ปัจจุบัน (ยืนยันจาก ESP32 แล้ว) - แสดง "..." ระหว่างรอค่าจริง
 * ครั้งแรก ไม่เดาว่า APPLY ที่กดไปสำเร็จจนกว่า home/status/auto/settings มาถึง
 *
 * UI แสดง/รับค่าเป็นนาที+วินาที แต่ autoSettings เก็บวินาทีรวมเหมือนเดิม
 * (ตรงกับ payload MQTT/backend/ESP32 ทุกจุด) แปลงเฉพาะตอน render เท่านั้น
 */
function autoSettingsCardHTML() {

    const lf = autoSettings.lightFanTimeout;
    const ac = autoSettings.acTimeout;

    const lfMin = lf !== null ? Math.floor(lf / 60) : '';
    const lfSec = lf !== null ? lf % 60 : '';
    const acMin = ac !== null ? Math.floor(ac / 60) : '';
    const acSec = ac !== null ? ac % 60 : '';

    return `

        <div class="card auto-settings-card">

            <div class="card-title">
                <div>
                    <span class="material-symbols-outlined">timer</span>
                    <span style="margin-left: 8px;">AUTOMATIC MODE SETTINGS</span>
                </div>
            </div>

            <div class="auto-settings-body">

                <div class="auto-settings-field">
                    <label>Light &amp; Fan Timeout</label>
                    <div class="auto-settings-input-row">
                        <div class="auto-settings-time-group">
                            <input
                                type="number"
                                id="auto-settings-lightfan-min"
                                min="0"
                                max="5"
                                value="${lfMin}"
                                placeholder="${lf !== null ? '' : '...'}"
                            >
                            <span>minutes</span>
                        </div>
                        <div class="auto-settings-time-group">
                            <input
                                type="number"
                                id="auto-settings-lightfan-sec"
                                min="0"
                                max="59"
                                value="${lfSec}"
                                placeholder="${lf !== null ? '' : '...'}"
                            >
                            <span>seconds</span>
                        </div>
                    </div>
                </div>

                <div class="auto-settings-field">
                    <label>AC Timeout</label>
                    <div class="auto-settings-input-row">
                        <div class="auto-settings-time-group">
                            <input
                                type="number"
                                id="auto-settings-ac-min"
                                min="0"
                                max="10"
                                value="${acMin}"
                                placeholder="${ac !== null ? '' : '...'}"
                            >
                            <span>minutes</span>
                        </div>
                        <div class="auto-settings-time-group">
                            <input
                                type="number"
                                id="auto-settings-ac-sec"
                                min="0"
                                max="59"
                                value="${acSec}"
                                placeholder="${ac !== null ? '' : '...'}"
                            >
                            <span>seconds</span>
                        </div>
                    </div>
                </div>

                <button class="auto-settings-apply-btn" onclick="applyAutoSettings()">
                    APPLY SETTINGS
                </button>

            </div>

        </div>
    `;
}

function refreshAutoSettingsCard() {

    if (currentPage !== 'settings') return;

    const card = document.querySelector('.auto-settings-card');
    if (!card) return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = autoSettingsCardHTML().trim();

    card.replaceWith(wrapper.firstElementChild);
}

/*
 * validate นาที/วินาทีแยกก่อนรวมเป็นวินาทีทั้งหมด (ตรงกับ payload MQTT/backend/ESP32
 * เดิมทุกจุด - ส่ง total seconds เหมือนเดิม ไม่ส่งนาที/วินาทีแยกไปที่ ESP32)
 * ไม่อัปเดต autoSettings ที่นี่ - รอ home/status/auto/settings ยืนยันค่าจริงเท่านั้น
 */
async function applyAutoSettings() {

    const lfMinInput = document.getElementById('auto-settings-lightfan-min');
    const lfSecInput = document.getElementById('auto-settings-lightfan-sec');
    const acMinInput = document.getElementById('auto-settings-ac-min');
    const acSecInput = document.getElementById('auto-settings-ac-sec');
    if (!lfMinInput || !lfSecInput || !acMinInput || !acSecInput) return;

    const lfMin = Number(lfMinInput.value);
    const lfSec = Number(lfSecInput.value);
    const acMin = Number(acMinInput.value);
    const acSec = Number(acSecInput.value);

    if (!Number.isInteger(lfMin) || lfMin < 0 || !Number.isInteger(lfSec) || lfSec < 0 || lfSec > 59) {
        showToast('Light & Fan Timeout: นาทีต้องไม่ติดลบ และวินาทีต้องอยู่ระหว่าง 0-59');
        return;
    }
    if (!Number.isInteger(acMin) || acMin < 0 || !Number.isInteger(acSec) || acSec < 0 || acSec > 59) {
        showToast('AC Timeout: นาทีต้องไม่ติดลบ และวินาทีต้องอยู่ระหว่าง 0-59');
        return;
    }

    const lightFanTimeout = (lfMin * 60) + lfSec;
    const acTimeout = (acMin * 60) + acSec;

    if (lightFanTimeout === 0) {
        showToast('Light & Fan Timeout ต้องมากกว่า 0 (0 นาที 0 วินาที ใช้ไม่ได้)');
        return;
    }
    if (acTimeout === 0) {
        showToast('AC Timeout ต้องมากกว่า 0 (0 นาที 0 วินาที ใช้ไม่ได้)');
        return;
    }

    if (lightFanTimeout > 300) {
        showToast('Light & Fan Timeout ต้องไม่เกิน 300 วินาที (5 นาที)');
        return;
    }
    if (acTimeout > 600) {
        showToast('AC Timeout ต้องไม่เกิน 600 วินาที (10 นาที)');
        return;
    }

    const result = await mqttClient.setAutoSettings(lightFanTimeout, acTimeout);
    if (!result || result.success === false) {
        showToast(`ส่งค่า timeout ไม่สำเร็จ: ${result && result.error ? result.error : 'unknown error'}`);
        return;
    }

    showToast('ส่งค่า timeout แล้ว กำลังรอ ESP32 ยืนยัน...');
}


/* =====================================================
   ROOM DASHBOARD CARD
===================================================== */

function roomDashboardCard(roomId) {

    const room =
        rooms[roomId];

    const allRooms = [
        { id: 'living', name: 'Living Room', icon: '<span class="material-symbols-outlined">weekend</span>' },
        { id: 'kitchen', name: 'Kitchen', icon: '<span class="material-symbols-outlined">kitchen</span>' },
        { id: 'bedroom', name: 'Bedroom', icon: '<span class="material-symbols-outlined">bed</span>' }
    ];

    return `

        <div class="card room-card">

            <div class="room-header">

                <div class="dashboard-room-selector">
                    <button class="dashboard-room-selector-trigger" aria-expanded="false" aria-haspopup="true">
                        <span class="room-icon">
                            ${room.icon}
                        </span>
                        <div class="dashboard-room-selector-label">
                            <h3>${room.name}</h3>
                            <small>${countActive(room)} active</small>
                        </div>
                        <span class="material-symbols-outlined dashboard-room-selector-arrow">
                            expand_more
                        </span>
                    </button>
                    <div class="dashboard-room-selector-menu" role="menu">
                        ${allRooms.map(r => `
                            <button
                                class="dashboard-room-selector-option ${r.id === roomId ? 'active' : ''}"
                                data-dashboard-room="${r.id}"
                                role="menuitem"
                            >
                                <span class="room-icon">${r.icon}</span>
                                <span>${r.name}</span>
                            </button>
                        `).join('')}
                    </div>
                </div>

                <span class="room-arrow">
                    ↗
                </span>

            </div>


            <div class="room-devices">

                ${Object.values(room.devices)
                    .slice(0,4)
                    .map(device => `

                        <div class="room-device">

                            <span>
                                ${deviceIcon(device.type)}
                                ${device.name}
                            </span>

                            <span>
                                ${deviceStatus(device)}
                            </span>

                        </div>

                    `)
                    .join("")}

            </div>


            <button
                class="ghost-button"
                data-room="${roomId}"
            >
                VIEW ROOM
            </button>

        </div>

    `;

}


/* =====================================================
   ROOMS PAGE
===================================================== */

function roomsHTML() {

    return `

        <div class="page-header">

            <div>

                <div class="eyebrow">
                    CONTROL CENTER
                </div>

                <h1>
                    Rooms
                </h1>

                <p class="subtitle">
                    Choose a room to control its devices.
                </p>

            </div>

        </div>


        <div class="room-grid">

            ${Object.entries(rooms)
                .map(([id, room]) => `

                    <div class="card large-room">

                        <div class="large-room-icon">
                            ${room.icon}
                        </div>

                        <h2>
                            ${room.name}
                        </h2>

                        <p class="subtitle">
                            ${Object.keys(room.devices).length}
                            devices
                        </p>


                        <div class="room-preview">

                            ${Object.values(room.devices)
                                .map(device => `

                                    <div>

                                        <span>
                                            ${deviceIcon(device.type)}
                                            ${device.name}
                                        </span>

                                        <b>
                                            ${deviceStatus(device)}
                                        </b>

                                    </div>

                                `)
                                .join("")}

                        </div>


                        <button
                            class="primary-button"
                            data-room="${id}"
                        >
                            OPEN ROOM
                        </button>

                    </div>

                `)
                .join("")}

        </div>

    `;

}


/* =====================================================
   ROOM DETAIL
===================================================== */

function roomDetailHTML(roomId) {

    const room =
        rooms[roomId];

    return `

        <div class="page-header">

            <div>

                <button
                    class="back-button"
                    data-page="rooms"
                >
                    ← Rooms
                </button>

                <div class="eyebrow">
                    ${room.name.toUpperCase()}
                </div>

                <h1>
                    ${room.icon}
                    ${room.name}
                </h1>

                <p class="subtitle">
                    Device control panel
                </p>

            </div>

        </div>


        <div class="device-grid">

            ${Object.entries(room.devices)
                .map(([id, device]) =>
                    deviceCard(roomId, id, device)
                )
                .join("")}

        </div>

    `;

}


/* =====================================================
   DEVICE CARD
===================================================== */

function deviceCard(roomId, deviceId, device) {

    if (device.type === "ac") {

        return `

            <div class="card device-card">

                <div class="device-top">

                    <span class="device-icon">
                        <span class="material-symbols-outlined">ac_unit</span>
                    </span>

                    <div
                        class="switch ${
                            device.state
                            ? "on"
                            : ""
                        }"
                        data-toggle="${roomId}:${deviceId}"
                    ></div>

                </div>


                <h3>
                    ${device.name}
                </h3>

                <small>
                    3-mode control
                </small>


                <div class="ac-levels">

                    ${[1,2,3]
                        .map(level => `

                            <button
                                class="ac-level ${
                                    device.level === level &&
                                    device.state
                                    ? "active"
                                    : ""
                                }"
                                data-ac-room="${roomId}"
                                data-ac-device="${deviceId}"
                                data-level="${level}"
                            >
                                ${acLevelLabel(level)}
                            </button>

                        `)
                        .join("")}

                </div>


                <div class="device-state">

                    ${device.state
                        ? `● ON · ${acLevelLabel(device.level)}`
                        : "○ OFF"}

                </div>

            </div>

        `;

    }


    if (device.type === "servo") {

        return `

            <div class="card device-card">

                <div class="device-top">

                    <span class="device-icon">
                        <span class="material-symbols-outlined">window</span>
                    </span>

                </div>


                <h3>
                    ${device.name}
                </h3>

                <small>
                    Servo control
                </small>


                <div class="servo-buttons">

                    <button
                        class="ac-level ${
                            device.state === "open"
                            ? "active"
                            : ""
                        }"
                        data-servo="${roomId}:${deviceId}:open"
                    >
                        OPEN
                    </button>

                    <button
                        class="ac-level ${
                            device.state === "closed"
                            ? "active"
                            : ""
                        }"
                        data-servo="${roomId}:${deviceId}:closed"
                    >
                        CLOSE
                    </button>

                </div>


                <div class="device-state">

                    ● ${device.state.toUpperCase()}

                </div>

            </div>

        `;

    }


    return `

        <div class="card device-card">

            <div class="device-top">

                <span class="device-icon">
                    ${deviceIcon(device.type)}
                </span>

                <div
                    class="switch ${
                        device.state
                        ? "on"
                        : ""
                    }"
                    data-toggle="${roomId}:${deviceId}"
                ></div>

            </div>


            <h3>
                ${device.name}
            </h3>

            <small>
                Power control
            </small>


            <div class="device-state">

                ${device.state
                    ? "● ON"
                    : "○ OFF"}

            </div>

        </div>

    `;

}


/* =====================================================
   SCENE PAGE
===================================================== */

// Load scenes from API
async function loadScenes() {
    try {
        const response = await fetch('/api/v2/scenes', {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            if (response.status === 401) {
                console.error('Scene API: Unauthorized');
                throw new Error('Authentication required');
            }
            throw new Error(`Failed to load scenes: ${response.status}`);
        }

        const data = await response.json();

        if (data.success && data.scenes) {
            // Transform API scenes to frontend format
            const apiScenes = data.scenes.map(scene => {
                // Map database icon to Material Symbols HTML
                let iconHTML = scene.icon || '<span class="material-symbols-outlined">routine</span>';

                // If icon is just text/emoji, wrap it appropriately
                if (iconHTML && !iconHTML.includes('<')) {
                    iconHTML = `<span class="scene-emoji">${iconHTML}</span>`;
                }

                // For system scenes, use legacy key for execution compatibility
                const legacyKey = sceneIdToLegacyKey[scene.id];
                const sceneId = legacyKey || `db-${scene.id}`;

                return {
                    id: sceneId,
                    dbId: scene.id,
                    name: scene.name,
                    icon: iconHTML,
                    actions: scene.actions ? scene.actions.length : 0,
                    isSystem: scene.is_system === 1,
                    description: scene.description
                };
            });

            // Update global scenes array
            scenes = apiScenes;

            // Fetch sleep timer status when scenes are loaded
            fetchSleepTimerStatus();

            return true;
        }

        return false;
    } catch (error) {
        console.error('Failed to load scenes:', error);
        // Keep legacy scenes as fallback
        scenes = [...scenesLegacy];
        return false;
    }
}

function scenesHTML() {

    return `

        <div class="page-header">

            <div>

                <div class="eyebrow">
                    AUTOMATION
                </div>

                <h1>
                    Scene Mode
                </h1>

                <p class="subtitle">
                    Run or customize your smart home routines.
                </p>

            </div>


            <button
                class="primary-button"
                id="create-scene"
            >
                ＋ CREATE SCENE
            </button>

        </div>

        <div id="sleep-timer-display" style="display: none;"></div>

        <div class="scene-grid">

            ${scenes.map(scene => `

                <div class="card scene-card">

                    <div class="scene-icon">
                        ${scene.icon}
                    </div>

                    <h2>
                        ${scene.name}
                    </h2>

                    <p>
                        ${scene.actions}
                        actions · ${scene.isSystem ? 'System' : 'Custom'}
                    </p>


                    <div class="scene-actions">

                        ${scene.dbId && !scene.isSystem ? `
                            <button
                                class="secondary-button"
                                data-edit-scene="${scene.dbId}"
                            >
                                EDIT
                            </button>
                            <button
                                class="danger-button"
                                data-delete-scene="${scene.dbId}"
                            >
                                DELETE
                            </button>
                        ` : scene.dbId ? `
                            <button
                                class="secondary-button"
                                data-edit-scene="${scene.dbId}"
                            >
                                EDIT
                            </button>
                        ` : ''}

                        <button
                            class="primary-button"
                            data-scene="${scene.id}"
                        >
                            RUN
                        </button>

                    </div>

                </div>

            `).join("")}

        </div>

    `;

}


/* =====================================================
   FINGERPRINT
===================================================== */

function fingerprintHTML() {

    const adminAuth = window.adminAuthState || { authorized: false };
    const enrollment = window.enrollmentState || { active: false };

    return `

        <div class="page-header">
            <div>
                <div class="eyebrow">ACCESS CONTROL</div>
                <h1>Fingerprint Management</h1>
                <p class="subtitle">AS608 Fingerprint Sensor</p>
            </div>
        </div>

        <!-- Admin Authorization Card -->
        <div class="card fp-admin-card" id="admin-auth-card">
            <div class="fp-admin-header">
                <div class="fp-admin-icon">
                    <span class="material-symbols-outlined">shield</span>
                </div>
                <div class="fp-admin-title">
                    <h3>Admin Authorization</h3>
                    <p class="fp-admin-subtitle">Administrator verification required</p>
                </div>
            </div>

            ${!adminAuth.authorized ? `
                <div class="fp-admin-status fp-admin-locked">
                    <span class="material-symbols-outlined">lock</span>
                    <span>Not Authorized</span>
                </div>
                <button class="primary-button fp-auth-button" onclick="requestAdminAuth()">
                    <span class="material-symbols-outlined">fingerprint</span>
                    VERIFY ADMIN FINGERPRINT
                </button>
                <p id="admin-auth-message" class="fp-auth-message"></p>
            ` : `
                <div class="fp-admin-status fp-admin-authorized">
                    <span class="material-symbols-outlined">check_circle</span>
                    <span>Authorized</span>
                </div>
                <div class="fp-admin-details">
                    <div class="fp-admin-detail-row">
                        <span class="fp-detail-label">Administrator</span>
                        <span class="fp-detail-value" id="admin-name">${adminAuth.user?.name || 'Unknown'}</span>
                    </div>
                    <div class="fp-admin-detail-row">
                        <span class="fp-detail-label">Role</span>
                        <span class="fp-role-badge fp-role-admin" id="admin-role">${adminAuth.user?.role || 'Unknown'}</span>
                    </div>
                    <div class="fp-admin-detail-row">
                        <span class="fp-detail-label">Session expires in</span>
                        <span class="fp-detail-value fp-countdown" id="admin-countdown">--:--</span>
                    </div>
                </div>
                <button class="danger-button fp-logout-button" onclick="logoutAdmin()">
                    <span class="material-symbols-outlined">logout</span>
                    END ADMIN SESSION
                </button>
            `}
        </div>

        ${adminAuth.authorized ? `
            <!-- Main Content Grid -->
            <div class="fp-content-grid">

                <!-- Enrollment Form Card -->
                <div class="card fp-enrollment-card" id="enrollment-card" style="display: ${enrollment.active ? 'none' : 'block'};">
                    <h3 class="fp-card-title">Enroll New Fingerprint</h3>

                    <div class="fp-form">
                        <div class="fp-form-group">
                            <label class="fp-label">Fingerprint ID</label>
                            <input type="number" id="enroll-fp-id" class="fp-input" min="1" max="10" value="2" placeholder="1-10">
                        </div>

                        <div class="fp-form-group">
                            <label class="fp-label">Name</label>
                            <input type="text" id="enroll-name" class="fp-input" placeholder="Enter full name">
                        </div>

                        <div class="fp-form-group">
                            <label class="fp-label">Role</label>
                            <div class="custom-dropdown fp-role-dropdown" data-dropdown-id="fp-role-dropdown">
                                <div class="custom-dropdown-selected" onclick="toggleCustomDropdown('fp-role-dropdown')">
                                    <span>USER</span>
                                    <svg class="custom-dropdown-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none">
                                        <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </div>
                                <div class="custom-dropdown-menu">
                                    <div class="custom-dropdown-option selected" data-value="USER" onclick="selectCustomDropdownOption('fp-role-dropdown', 'USER', 'USER')">
                                        USER
                                    </div>
                                    <div class="custom-dropdown-option" data-value="ADMIN" onclick="selectCustomDropdownOption('fp-role-dropdown', 'ADMIN', 'ADMIN')">
                                        ADMIN
                                    </div>
                                </div>
                                <input type="hidden" id="enroll-role" value="USER">
                            </div>
                        </div>

                        <button class="primary-button fp-enroll-button" onclick="startEnrollment()">
                            <span class="material-symbols-outlined">fingerprint</span>
                            START ENROLLMENT
                        </button>
                    </div>
                </div>

                <!-- Status Card -->
                <div class="card fp-status-card" style="display: ${enrollment.active ? 'none' : 'block'};">
                    <h3 class="fp-card-title">Fingerprint Status</h3>
                    <div class="fp-status-info">
                        <div class="fp-status-item">
                            <span class="material-symbols-outlined">fingerprint</span>
                            <div class="fp-status-text">
                                <div class="fp-status-label">Sensor</div>
                                <div class="fp-status-value">AS608 Ready</div>
                            </div>
                        </div>
                        <div class="fp-status-item">
                            <span class="material-symbols-outlined">badge</span>
                            <div class="fp-status-text">
                                <div class="fp-status-label">Capacity</div>
                                <div class="fp-status-value">10 slots</div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>

            <!-- Enrollment Progress Card -->
            <div class="card fp-progress-card" id="enrollment-progress-card" style="display: ${enrollment.active ? 'block' : 'none'};">
                <h3 class="fp-card-title">Enrollment In Progress</h3>

                <div id="enrollment-status" class="fp-enrollment-status">
                    <p id="enrollment-message" class="fp-enrollment-message">Initializing...</p>
                    <div class="fp-progress-bar-container">
                        <div id="enrollment-progress-bar" class="fp-progress-bar"></div>
                    </div>
                </div>

                <button class="danger-button fp-cancel-button" onclick="cancelEnrollment()">
                    <span class="material-symbols-outlined">cancel</span>
                    CANCEL ENROLLMENT
                </button>
            </div>

            <!-- Registered Fingerprints -->
            <div class="card fp-list-card">
                <h3 class="fp-card-title">Registered Fingerprints</h3>

                <div class="fp-table">
                    <div class="fp-table-header">
                        <span class="fp-col-id">ID</span>
                        <span class="fp-col-name">Name</span>
                        <span class="fp-col-role">Role</span>
                        <span class="fp-col-created">Created</span>
                        <span class="fp-col-actions">Actions</span>
                    </div>

                    <div id="fingerprint-list" class="fp-table-body">
                        <p class="fp-table-loading">Loading fingerprints...</p>
                    </div>
                </div>
            </div>
        ` : ''}

    `;

}


/* =====================================================
   HISTORY
===================================================== */

function historyHTML() {
    return `
        <div class="page-header history-page-header">
            <div>
                <div class="eyebrow">ACTIVITY LOG</div>
                <h1>History</h1>
                <p class="subtitle">Browse and filter smart home events stored in MySQL.</p>
            </div>
            <div class="history-page-actions">
                <button class="ghost-button history-refresh" onclick="loadHistory(true)">
                    <span class="material-symbols-outlined">refresh</span> REFRESH
                </button>
                <button class="danger-button history-clear-all" onclick="confirmClearHistory()">
                    <span class="material-symbols-outlined">delete</span> CLEAR HISTORY
                </button>
            </div>
        </div>

        <div class="history-filters card">
            <div class="history-filter">
                <label>ROOM</label>
                <select id="history-room-filter" onchange="applyHistoryFilters()" style="display:none"><option value="">All Rooms</option></select>
                <div class="custom-select" data-select-id="history-room-filter">
                    <div class="custom-select-trigger">
                        <span class="custom-select-value">All Rooms</span>
                        <span class="material-symbols-outlined custom-select-icon">expand_more</span>
                    </div>
                    <div class="custom-select-menu">
                        <div class="custom-select-option" data-value="">All Rooms</div>
                    </div>
                </div>
            </div>
            <div class="history-filter">
                <label>DEVICE</label>
                <select id="history-device-filter" onchange="applyHistoryFilters()" style="display:none"><option value="">All Devices</option></select>
                <div class="custom-select" data-select-id="history-device-filter">
                    <div class="custom-select-trigger">
                        <span class="custom-select-value">All Devices</span>
                        <span class="material-symbols-outlined custom-select-icon">expand_more</span>
                    </div>
                    <div class="custom-select-menu">
                        <div class="custom-select-option" data-value="">All Devices</div>
                    </div>
                </div>
            </div>
            <div class="history-filter">
                <label>EVENT TYPE</label>
                <select id="history-event-filter" onchange="applyHistoryFilters()" style="display:none"><option value="">All Events</option></select>
                <div class="custom-select" data-select-id="history-event-filter">
                    <div class="custom-select-trigger">
                        <span class="custom-select-value">All Events</span>
                        <span class="material-symbols-outlined custom-select-icon">expand_more</span>
                    </div>
                    <div class="custom-select-menu">
                        <div class="custom-select-option" data-value="">All Events</div>
                    </div>
                </div>
            </div>
            <div class="history-filter history-search">
                <label>SEARCH</label>
                <div class="history-search-box"><span class="material-symbols-outlined">search</span><input id="history-search-filter" placeholder="Search message..." oninput="applyHistoryFilters()"></div>
            </div>
            <button class="ghost-button history-clear" onclick="clearHistoryFilters()">CLEAR</button>
        </div>

        <div class="history-stats">
            <div class="card history-stat"><span class="material-symbols-outlined">format_list_bulleted</span><div><small>TOTAL EVENTS</small><strong id="history-total">0</strong></div></div>
            <div class="card history-stat"><span class="material-symbols-outlined">filter_alt</span><div><small>SHOWING</small><strong id="history-showing">0</strong></div></div>
            <div class="card history-stat"><span class="material-symbols-outlined">schedule</span><div><small>LATEST EVENT</small><strong id="history-latest">—</strong></div></div>
        </div>

        <div class="card table-card history-table-card">
            <div class="table-header history-table-grid"><span>TIME</span><span>TYPE</span><span>ROOM</span><span>DEVICE</span><span>EVENT</span></div>
            <div id="history-table-body"><div class="history-loading"><span class="material-symbols-outlined">progress_activity</span> Loading history...</div></div>
        </div>
        <div id="history-pagination" class="history-pagination"></div>
    `;
}

let historyEvents = [];
let historyFilteredEvents = [];
let historyPage = 1;
let historyTotal = 0;
const HISTORY_PAGE_SIZE = 10;

async function loadHistory(resetPage = false) {
    const tbody = document.getElementById('history-table-body');
    if (tbody) tbody.innerHTML = '<div class="history-loading"><span class="material-symbols-outlined">progress_activity</span> Loading history...</div>';
    try {
        const response = await authenticatedFetch('/api/history?limit=1000');
        const data = await response.json();
        if (data.success && Array.isArray(data.data)) {
            historyEvents = data.data;
            // pagination.total is the authoritative row count in MySQL; data.length
            // is only what this request returned (capped by limit)
            historyTotal = data.pagination?.total ?? historyEvents.length;
            if (resetPage) historyPage = 1;
            populateHistoryFilters();
            applyHistoryFilters();
            // Initialize custom selects after populating filters
            initCustomSelects();
        } else {
            renderHistoryError('Failed to load history');
        }
    } catch (error) {
        console.error('Failed to load history:', error.message);
        renderHistoryError('Database unavailable');
    }
}

function populateHistoryFilters() {
    fillHistorySelect('history-room-filter', historyEvents.map(e => e.room));
    fillHistorySelect('history-device-filter', historyEvents.map(e => e.device));
    fillHistorySelect('history-event-filter', historyEvents.map(e => e.event_type));
}
function fillHistorySelect(id, values) {
    const el = document.getElementById(id); if (!el) return;
    const current = el.value;
    const first = el.options[0].outerHTML;
    const unique = [...new Set(values.filter(Boolean).map(v => String(v)))].sort();
    el.innerHTML = first + unique.map(v => `<option value="${escapeHistoryHTML(v)}">${escapeHistoryHTML(formatHistoryType(v))}</option>`).join('');
    el.value = unique.includes(current) ? current : '';

    // Update custom dropdown menu
    updateCustomSelectMenu(id, el.options);
}

function updateCustomSelectMenu(selectId, options) {
    const customSelect = document.querySelector(`.custom-select[data-select-id="${selectId}"]`);
    if (!customSelect) return;

    const menu = customSelect.querySelector('.custom-select-menu');
    if (!menu) return;

    menu.innerHTML = '';
    for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const div = document.createElement('div');
        div.className = 'custom-select-option';
        div.setAttribute('data-value', option.value);
        div.textContent = option.text;
        menu.appendChild(div);
    }

    // Reattach click handlers
    initCustomSelectOptions(customSelect);
}

function initCustomSelects() {
    const customSelects = document.querySelectorAll('.custom-select');
    customSelects.forEach(customSelect => {
        const trigger = customSelect.querySelector('.custom-select-trigger');
        const menu = customSelect.querySelector('.custom-select-menu');
        const selectId = customSelect.getAttribute('data-select-id');

        if (!trigger || !menu || !selectId) return;

        // Click trigger to toggle menu
        trigger.onclick = (e) => {
            e.stopPropagation();
            const isOpen = customSelect.classList.contains('open');

            // Close all other custom selects
            document.querySelectorAll('.custom-select.open').forEach(cs => {
                cs.classList.remove('open');
            });

            // Toggle this one
            if (!isOpen) {
                customSelect.classList.add('open');
            }
        };

        // Initialize option click handlers
        initCustomSelectOptions(customSelect);
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-select')) {
            document.querySelectorAll('.custom-select.open').forEach(cs => {
                cs.classList.remove('open');
            });
        }
    });
}

function initCustomSelectOptions(customSelect) {
    const selectId = customSelect.getAttribute('data-select-id');
    const hiddenSelect = document.getElementById(selectId);
    const valueDisplay = customSelect.querySelector('.custom-select-value');
    const menu = customSelect.querySelector('.custom-select-menu');

    if (!hiddenSelect || !valueDisplay || !menu) return;

    const options = menu.querySelectorAll('.custom-select-option');
    options.forEach(option => {
        option.onclick = (e) => {
            e.stopPropagation();

            const value = option.getAttribute('data-value');
            const text = option.textContent;

            // Update hidden select
            hiddenSelect.value = value;

            // Update display
            valueDisplay.textContent = text;

            // Update selected state
            options.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');

            // Close menu
            customSelect.classList.remove('open');

            // Trigger change event on hidden select
            hiddenSelect.dispatchEvent(new Event('change'));
        };
    });
}
function applyHistoryFilters() {
    const room = document.getElementById('history-room-filter')?.value || '';
    const device = document.getElementById('history-device-filter')?.value || '';
    const type = document.getElementById('history-event-filter')?.value || '';
    const search = (document.getElementById('history-search-filter')?.value || '').toLowerCase().trim();
    historyFilteredEvents = historyEvents.filter(e =>
        (!room || e.room === room) && (!device || e.device === device) && (!type || e.event_type === type) &&
        (!search || `${e.message || ''} ${e.room || ''} ${e.device || ''} ${e.event_type || ''}`.toLowerCase().includes(search))
    );
    historyPage = 1;
    renderHistoryTable();
}
function clearHistoryFilters() {
    ['history-room-filter','history-device-filter','history-event-filter','history-search-filter'].forEach(id => { const e=document.getElementById(id); if(e)e.value=''; });

    // Reset custom select displays
    document.querySelectorAll('.custom-select').forEach(customSelect => {
        const selectId = customSelect.getAttribute('data-select-id');
        const hiddenSelect = document.getElementById(selectId);
        const valueDisplay = customSelect.querySelector('.custom-select-value');
        const firstOption = customSelect.querySelector('.custom-select-option[data-value=""]');

        if (hiddenSelect && valueDisplay && firstOption) {
            valueDisplay.textContent = firstOption.textContent;
            customSelect.querySelectorAll('.custom-select-option').forEach(opt => opt.classList.remove('selected'));
            firstOption.classList.add('selected');
        }
    });

    applyHistoryFilters();
}
function renderHistoryTable() {
    const tbody = document.getElementById('history-table-body');
    if (!tbody) return;
    const totalPages = Math.max(1, Math.ceil(historyFilteredEvents.length / HISTORY_PAGE_SIZE));
    if (historyPage > totalPages) historyPage = totalPages;
    const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    const events = historyFilteredEvents.slice(start, start + HISTORY_PAGE_SIZE);
    document.getElementById('history-total').textContent = historyTotal;
    document.getElementById('history-showing').textContent = historyFilteredEvents.length;
    document.getElementById('history-latest').textContent = historyEvents[0]?.created_at ? formatHistoryTime(historyEvents[0].created_at, true) : '—';
    if (!events.length) tbody.innerHTML = '<div class="history-empty"><span class="material-symbols-outlined">search_off</span><b>No events found</b><small>Try changing or clearing your filters.</small></div>';
    else tbody.innerHTML = events.map(e => `
        <div class="table-row history-table-grid">
            <b class="history-time">${escapeHistoryHTML(formatHistoryTime(e.created_at))}</b>
            <span><span class="history-badge type-${String(e.event_type||'').toLowerCase().replace(/_/g,'-')}">${escapeHistoryHTML(formatHistoryType(e.event_type || 'UNKNOWN'))}</span></span>
            <span>${e.room ? `<span class="history-tag">${escapeHistoryHTML(e.room)}</span>` : '<span class="history-muted">—</span>'}</span>
            <span>${e.device ? escapeHistoryHTML(e.device) : '<span class="history-muted">—</span>'}</span>
            <span class="history-message">${escapeHistoryHTML(e.message || '—')}</span>
        </div>`).join('');
    renderHistoryPagination(totalPages);
}
function renderHistoryPagination(totalPages) {
    const el = document.getElementById('history-pagination'); if (!el) return;
    if (!historyFilteredEvents.length) { el.innerHTML=''; return; }
    el.innerHTML = `<span>Page ${historyPage} of ${totalPages}</span><div><button ${historyPage===1?'disabled':''} onclick="changeHistoryPage(-1)">‹</button><button ${historyPage===totalPages?'disabled':''} onclick="changeHistoryPage(1)">›</button></div>`;
}
function changeHistoryPage(delta) { historyPage += delta; renderHistoryTable(); }
function formatHistoryType(v) { return String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function formatHistoryTime(v, short=false) {
    if (!v) return '—';
    const raw = String(v);
    // API returns ISO ("2026-09-07T10:38:05.000Z"); a bare MySQL DATETIME
    // ("2026-09-07 10:38:05") has no zone, so pin it to UTC before parsing.
    const d = new Date(/[Tt].*(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return raw;
    return d.toLocaleString([], short
        ? { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }
        : { month:'short', day:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function escapeHistoryHTML(value) { const div=document.createElement('div'); div.textContent=value ?? ''; return div.innerHTML; }
function renderHistoryError(message) { const tbody=document.getElementById('history-table-body'); if(tbody)tbody.innerHTML=`<div class="history-error"><span class="material-symbols-outlined">error</span>${escapeHistoryHTML(message)}</div>`; }

function confirmClearHistory() {
    openModal(`
        <h2>Clear All History?</h2>
        <p>This will permanently delete all event history records. This action cannot be undone.</p>
        <div class="modal-buttons">
            <button class="secondary-button" onclick="closeModal()">Cancel</button>
            <button class="danger-button" onclick="clearAllHistory()">Delete All History</button>
        </div>
    `);
}

async function clearAllHistory() {
    closeModal();
    const tbody = document.getElementById('history-table-body');
    if (tbody) tbody.innerHTML = '<div class="history-loading"><span class="material-symbols-outlined">progress_activity</span> Clearing history...</div>';
    try {
        const response = await authenticatedFetch('/api/history', { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            historyEvents = [];
            historyFilteredEvents = [];
            historyTotal = 0;
            historyPage = 1;
            renderHistoryTable();
        } else {
            // Deletion failed - restore the existing history, don't fake success
            renderHistoryTable();
            showToast('Failed to clear history');
        }
    } catch (error) {
        console.error('Failed to clear history:', error.message);
        renderHistoryTable();
        showToast('Failed to clear history');
    }
}


/* =====================================================
   TELEGRAM
===================================================== */

let telegramSettings = null;
let telegramLoading = false;
let telegramSaving = false;

async function loadTelegramSettings() {
    try {
        telegramLoading = true;
        const response = await authenticatedFetch('/api/telegram/settings');
        const data = await response.json();

        if (data.success) {
            telegramSettings = data.settings;
            return true;
        } else {
            console.error('Failed to load Telegram settings:', data.message);
            return false;
        }
    } catch (err) {
        console.error('Error loading Telegram settings:', err.message);
        return false;
    } finally {
        telegramLoading = false;
    }
}

async function saveTelegramSettings() {
    if (telegramSaving) return;

    try {
        telegramSaving = true;

        // Get values from form
        const cooldownMinutes = parseInt(document.getElementById('telegram-cooldown-minutes')?.value ?? '0');
        const cooldownSeconds = parseInt(document.getElementById('telegram-cooldown-seconds')?.value ?? '5');

        // Convert minutes + seconds to total seconds for backend
        const totalSeconds = (cooldownMinutes * 60) + cooldownSeconds;

        const settings = {
            telegram_enabled: document.getElementById('telegram-enabled')?.checked ?? true,
            telegram_cooldown_value: totalSeconds,
            telegram_cooldown_unit: 'seconds',
            alert_motion_enabled: document.getElementById('alert-motion-enabled')?.checked ?? true,
            alert_fingerprint_enabled: document.getElementById('alert-fingerprint-enabled')?.checked ?? true,
            alert_security_enabled: document.getElementById('alert-security-enabled')?.checked ?? true,
            motion_living_enabled: document.getElementById('motion-living-enabled')?.checked ?? true,
            motion_kitchen_enabled: document.getElementById('motion-kitchen-enabled')?.checked ?? true,
            motion_bedroom_enabled: document.getElementById('motion-bedroom-enabled')?.checked ?? true
        };

        const response = await authenticatedFetch('/api/telegram/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });

        const data = await response.json();

        if (data.success) {
            showToast('Telegram settings saved successfully');
            // Reload settings from backend
            await loadTelegramSettings();
            // Reset saving state BEFORE re-rendering
            telegramSaving = false;
            // Re-render page with new settings
            renderTelegramPage();
        } else {
            showToast('Failed to save settings: ' + (data.message || 'Unknown error'));
        }
    } catch (err) {
        console.error('Error saving Telegram settings:', err.message);
        showToast('Error saving settings: ' + err.message);
    } finally {
        telegramSaving = false;
    }
}

function renderTelegramPage() {
    const content = document.getElementById("page-content");
    if (content) {
        content.innerHTML = telegramHTML();
        attachTelegramEventListeners();
    }
}

function attachTelegramEventListeners() {
    const saveButton = document.getElementById('save-telegram-settings');
    if (saveButton) {
        saveButton.onclick = saveTelegramSettings;
    }

    const testButton = document.getElementById('test-telegram');
    if (testButton) {
        testButton.onclick = testTelegramReal;
    }
}

function telegramHTML() {

    if (telegramLoading) {
        return `
            <div class="page-header">
                <div>
                    <div class="eyebrow">NOTIFICATIONS</div>
                    <h1>Telegram</h1>
                    <p class="subtitle">Loading settings...</p>
                </div>
            </div>
        `;
    }

    if (!telegramSettings) {
        return `
            <div class="page-header">
                <div>
                    <div class="eyebrow">NOTIFICATIONS</div>
                    <h1>Telegram</h1>
                    <p class="subtitle">Backend connection failed - using demo mode</p>
                </div>
            </div>
            <div class="card">
                <p>Unable to load Telegram settings from backend.</p>
            </div>
        `;
    }

    // Convert backend cooldown (always in seconds) to minutes + seconds for UI
    const totalSeconds = telegramSettings.telegram_cooldown_value || 5;
    const cooldownMinutes = Math.floor(totalSeconds / 60);
    const cooldownSeconds = totalSeconds % 60;

    return `
        <div class="page-header">
            <div>
                <div class="eyebrow">NOTIFICATIONS</div>
                <h1>
                    <span class="material-symbols-outlined" style="vertical-align: middle; margin-right: 8px;">send</span>
                    Telegram
                </h1>
                <p class="subtitle">Configure notification behavior and smart home alerts.</p>
            </div>
        </div>

        <div class="telegram-settings-grid">

            <div class="card">
                <h2>
                    <span class="material-symbols-outlined">notifications</span>
                    Notification Settings
                </h2>

                <div class="telegram-setting-row">
                    <label class="toggle-label">
                        <input type="checkbox" id="telegram-enabled" ${telegramSettings.telegram_enabled ? 'checked' : ''}>
                        <span>Enable Telegram Notifications</span>
                    </label>
                </div>

                <div class="telegram-setting-section">
                    <label class="telegram-label">Alert Cooldown</label>
                    <p class="telegram-help">Minimum time between consecutive alerts</p>

                    <div class="telegram-cooldown-inputs">
                        <div class="telegram-time-input">
                            <label>Minutes</label>
                            <input
                                type="number"
                                id="telegram-cooldown-minutes"
                                value="${cooldownMinutes}"
                                min="0"
                                max="60"
                            >
                        </div>
                        <div class="telegram-time-input">
                            <label>Seconds</label>
                            <input
                                type="number"
                                id="telegram-cooldown-seconds"
                                value="${cooldownSeconds}"
                                min="0"
                                max="59"
                            >
                        </div>
                    </div>
                </div>
            </div>

            <div class="card">
                <h2>
                    <span class="material-symbols-outlined">notifications_active</span>
                    Alert Types
                </h2>

                <div class="telegram-setting-row">
                    <div class="telegram-setting-info">
                        <span class="material-symbols-outlined">directions_walk</span>
                        <span>Motion Detection Alerts</span>
                    </div>
                    <label class="toggle-label-compact">
                        <input type="checkbox" id="alert-motion-enabled" ${telegramSettings.alert_motion_enabled ? 'checked' : ''}>
                    </label>
                </div>

                <div class="telegram-setting-row">
                    <div class="telegram-setting-info">
                        <span class="material-symbols-outlined">fingerprint</span>
                        <span>Fingerprint Failed Alerts</span>
                    </div>
                    <label class="toggle-label-compact">
                        <input type="checkbox" id="alert-fingerprint-enabled" ${telegramSettings.alert_fingerprint_enabled ? 'checked' : ''}>
                    </label>
                </div>

                <div class="telegram-setting-row">
                    <div class="telegram-setting-info">
                        <span class="material-symbols-outlined">shield</span>
                        <span>Security Alerts</span>
                    </div>
                    <label class="toggle-label-compact">
                        <input type="checkbox" id="alert-security-enabled" ${telegramSettings.alert_security_enabled ? 'checked' : ''}>
                    </label>
                </div>
            </div>

            <div class="card telegram-rooms-card">
                <h2>
                    <span class="material-symbols-outlined">sensor_door</span>
                    Motion Detection Rooms
                </h2>
                <p class="telegram-help" style="margin-bottom: 20px;">
                    Enable motion alerts for specific rooms (only active in Exit/Sleep modes)
                </p>

                <div class="telegram-setting-row">
                    <div class="telegram-setting-info">
                        <span class="material-symbols-outlined">chair</span>
                        <span>Living Room</span>
                    </div>
                    <label class="toggle-label-compact">
                        <input type="checkbox" id="motion-living-enabled" ${telegramSettings.motion_living_enabled ? 'checked' : ''}>
                    </label>
                </div>

                <div class="telegram-setting-row">
                    <div class="telegram-setting-info">
                        <span class="material-symbols-outlined">restaurant</span>
                        <span>Kitchen</span>
                    </div>
                    <label class="toggle-label-compact">
                        <input type="checkbox" id="motion-kitchen-enabled" ${telegramSettings.motion_kitchen_enabled ? 'checked' : ''}>
                    </label>
                </div>

                <div class="telegram-setting-row">
                    <div class="telegram-setting-info">
                        <span class="material-symbols-outlined">bed</span>
                        <span>Bedroom</span>
                    </div>
                    <label class="toggle-label-compact">
                        <input type="checkbox" id="motion-bedroom-enabled" ${telegramSettings.motion_bedroom_enabled ? 'checked' : ''}>
                    </label>
                </div>
            </div>

        </div>

        <div class="telegram-actions">
            <button
                id="save-telegram-settings"
                class="primary-button"
                ${telegramSaving ? 'disabled' : ''}
            >
                <span class="material-symbols-outlined">save</span>
                ${telegramSaving ? 'SAVING...' : 'SAVE SETTINGS'}
            </button>

            <button
                class="secondary-button"
                id="test-telegram"
            >
                <span class="material-symbols-outlined">send</span>
                SEND TEST NOTIFICATION
            </button>
        </div>
    `;

}


/* =====================================================
   SETTINGS
===================================================== */

function settingsHTML() {

    return `

        <div class="page-header">

            <div>

                <div class="eyebrow">
                    SYSTEM
                </div>

                <h1>
                    Settings
                </h1>

                <p class="subtitle">
                    Frontend demo preferences.
                </p>

            </div>

        </div>


        <!-- AUTOMATIC MODE SETTINGS -->

        ${autoSettingsCardHTML()}


        <div class="page-header">

            <div>

                <div class="eyebrow">
                    TELEMETRY
                </div>

                <h1>
                    Automatic Mode Debug Console
                </h1>

                <p class="subtitle">
                    Live ESP32 debug log ผ่าน MQTT (home/debug/log) - ไม่ต้องต่อ USB Serial Monitor
                </p>

            </div>

        </div>

        <div class="card debug-console-card">
            <div id="debug-console-log" class="debug-console-log"></div>
        </div>

    `;

}


function settingCard(title, value) {

    return `

        <div class="card setting-card">

            <small>
                ${title}
            </small>

            <b>
                ${value}
            </b>

            <div class="switch on"></div>

        </div>

    `;

}


/* =====================================================
   SIMPLE DEVICE CONTROL
===================================================== */

function simpleControl(roomId, deviceId, label) {

    const device =
        rooms[roomId].devices[deviceId];

    return `

        <div class="device-row">

            <span>
                ${label}
            </span>

            <div
                class="switch ${
                    device.state
                    ? "on"
                    : ""
                }"
                data-toggle="${roomId}:${deviceId}"
            ></div>

        </div>

    `;

}


/* =====================================================
   DEVICE ICON
===================================================== */

function deviceIcon(type) {

    const icons = {

        ac: '<span class="material-symbols-outlined">ac_unit</span>',

        fan: '<span class="material-symbols-outlined">toys_fan</span>',

        light: '<span class="material-symbols-outlined">lightbulb</span>',

        servo: '<span class="material-symbols-outlined">window</span>'

    };

    return icons[type] || "•";

}


/* =====================================================
   AC LEVEL LABEL
===================================================== */

// ชื่อที่แสดงบนปุ่มแอร์ - index ตรงกับ level ที่ส่งให้ backend (0-3)
// เปลี่ยนแค่ชื่อที่แสดง ไม่กระทบ level ที่ยิงไป MQTT
const AC_LEVEL_LABELS = ['OFF', 'SLEEP', 'COOL', 'COOLER'];

const acLevelLabel = level => AC_LEVEL_LABELS[level] || 'OFF';


/* =====================================================
   DEVICE STATUS
===================================================== */

function deviceStatus(device) {

    if (device.type === "ac") {

        return device.state
            ? acLevelLabel(device.level)
            : "OFF";

    }

    if (device.type === "servo") {

        return device.state
            .toUpperCase();

    }

    return device.state
        ? "ON"
        : "OFF";

}


/* =====================================================
   COUNT ACTIVE
===================================================== */

function countActive(room) {

    return Object.values(room.devices)
        .filter(device => {

            if (device.type === "servo") {

                return device.state === "open";

            }

            return device.state === true;

        })
        .length;

}


/* =====================================================
   DYNAMIC BUTTONS
===================================================== */

function bindDynamicButtons() {


    /* CHANGE PAGE */

    document
        .querySelectorAll("[data-page]")
        .forEach(button => {

            button.onclick = () => {

                currentPage =
                    button.dataset.page;

                // Reset room detail mode when changing pages
                if (currentPage !== "rooms") {
                    isInRoomDetail = false;
                } else {
                    // If clicking on rooms nav item, show room list
                    isInRoomDetail = false;
                }

                document
                    .querySelectorAll(".nav-item")
                    .forEach(item => {

                        item.classList.toggle(
                            "active",
                            item.dataset.page ===
                            currentPage
                        );

                    });

                renderPage();

            };

        });


    /* OPEN ROOM */

    document
        .querySelectorAll("[data-room]")
        .forEach(button => {

            button.onclick = () => {

                currentRoom =
                    button.dataset.room;

                currentPage = "rooms";

                isInRoomDetail = true;

                document
                    .querySelectorAll(".nav-item")
                    .forEach(item => {

                        item.classList.toggle(
                            "active",
                            item.dataset.page === "rooms"
                        );

                    });

                document.getElementById(
                    "page-content"
                ).innerHTML =
                    roomDetailHTML(currentRoom);

                bindDynamicButtons();

            };

        });


    /* DASHBOARD ROOM SELECTOR */

    const dashboardRoomTrigger = document.querySelector('.dashboard-room-selector-trigger');
    const dashboardRoomMenu = document.querySelector('.dashboard-room-selector-menu');

    if (dashboardRoomTrigger && dashboardRoomMenu) {

        // Toggle dropdown
        dashboardRoomTrigger.onclick = (e) => {
            e.stopPropagation();
            const isOpen = dashboardRoomMenu.classList.contains('open');
            dashboardRoomMenu.classList.toggle('open');
            dashboardRoomTrigger.setAttribute('aria-expanded', !isOpen);
        };

        // Select room
        document.querySelectorAll('[data-dashboard-room]').forEach(option => {
            option.onclick = (e) => {
                e.stopPropagation();
                const selectedRoom = option.dataset.dashboardRoom;

                if (selectedRoom !== currentDashboardRoom) {
                    currentDashboardRoom = selectedRoom;

                    // Re-render only the dashboard page if we're on it
                    if (currentPage === 'dashboard') {
                        document.getElementById('page-content').innerHTML = dashboardHTML();
                        bindDynamicButtons();
                    }
                }

                dashboardRoomMenu.classList.remove('open');
                dashboardRoomTrigger.setAttribute('aria-expanded', 'false');
            };
        });

        // Close on outside click
        document.addEventListener('click', () => {
            if (dashboardRoomMenu.classList.contains('open')) {
                dashboardRoomMenu.classList.remove('open');
                dashboardRoomTrigger.setAttribute('aria-expanded', 'false');
            }
        });
    }


    /* TOGGLE */

    document
        .querySelectorAll("[data-toggle]")
        .forEach(button => {

            button.onclick = async () => {

                const [
                    roomId,
                    deviceId
                ] =
                    button.dataset.toggle.split(":");


                const device =
                    rooms[roomId]
                        .devices[deviceId];


                const newState = !device.state;

                // Send MQTT command based on device type
                if (device.type === 'light') {
                    await mqttClient.controlLED(roomId, newState ? 'on' : 'off');
                } else if (device.type === 'fan') {
                    await mqttClient.controlFan(roomId, newState ? 'on' : 'off');
                } else if (device.type === 'ac') {
                    // ปิด = level 0, เปิด = กลับไประดับล่าสุด (ถ้ายังไม่เคยตั้งใช้ 1)
                    if (newState && !device.level) {
                        device.level = 1;
                    }
                    await mqttClient.controlAC(roomId, newState ? device.level : 0);
                }

                // Update local state (will be confirmed by MQTT response)
                device.state = newState;

                addLog(
                    roomId,
                    `${device.name} ${device.state ? "ON" : "OFF"}`,
                    deviceIcon(device.type)
                );

                // Stay in current room detail view
                document.getElementById(
                    "page-content"
                ).innerHTML =
                    roomDetailHTML(roomId);

                bindDynamicButtons();

            };

        });


    /* AC LEVEL */

    document
        .querySelectorAll("[data-ac-room]")
        .forEach(button => {

            button.onclick = async () => {

                const roomId =
                    button.dataset.acRoom;

                const deviceId =
                    button.dataset.acDevice;

                const level =
                    Number(button.dataset.level);


                const device =
                    rooms[roomId]
                        .devices[deviceId];


                // Send MQTT command
                await mqttClient.controlAC(roomId, level);

                device.state = true;

                device.level = level;


                addLog(

                    roomId,

                    `${device.name} ${acLevelLabel(level)}`,

                    "❄️"

                );


                // Stay in current room detail view
                document.getElementById(
                    "page-content"
                ).innerHTML =
                    roomDetailHTML(roomId);

                bindDynamicButtons();

            };

        });


    /* SERVO */

    document
        .querySelectorAll("[data-servo]")
        .forEach(button => {

            button.onclick = async () => {

                const [
                    roomId,
                    deviceId,
                    state
                ] =
                    button.dataset.servo.split(":");


                const device =
                    rooms[roomId]
                        .devices[deviceId];

                // Backend ต้องการ format: {type}_{room} เช่น "window_bedroom"
                const deviceFullId = `${deviceId}_${roomId}`;

                // Send MQTT command
                await mqttClient.controlServo(deviceFullId, state);

                device.state = state;


                addLog(

                    roomId,

                    `${device.name} ${state}`,

                    "🪟"

                );


                // Stay in current room detail view
                document.getElementById(
                    "page-content"
                ).innerHTML =
                    roomDetailHTML(roomId);

                bindDynamicButtons();

            };

        });


    /* SCENE */

    document
        .querySelectorAll("[data-scene]")
        .forEach(button => {

            button.onclick = () => {

                runScene(
                    button.dataset.scene
                );

            };

        });


    /* CREATE SCENE */

    const createScene =
        document.getElementById(
            "create-scene"
        );

    if (createScene) {

        createScene.onclick =
            createSceneModal;

    }


    /* EDIT SCENE BUTTONS */

    document
        .querySelectorAll("[data-edit-scene]")
        .forEach(button => {

            button.onclick = () => {

                const sceneId = button.dataset.editScene;

                if (sceneId) {
                    editSceneModal(parseInt(sceneId, 10));
                }

            };

        });


    /* DELETE SCENE BUTTONS */

    document
        .querySelectorAll("[data-delete-scene]")
        .forEach(button => {

            button.onclick = () => {

                const sceneId = button.dataset.deleteScene;

                if (sceneId) {
                    deleteScene(parseInt(sceneId, 10));
                }

            };

        });

    /* FINGERPRINT */

    const success =
        document.getElementById(
            "fingerprint-success"
        );

    if (success) {

        success.onclick =
            fingerprintSuccess;

    }


    const failed =
        document.getElementById(
            "fingerprint-fail"
        );

    if (failed) {

        failed.onclick =
            fingerprintFailed;

    }


    const addFingerprint =
        document.getElementById(
            "add-fingerprint"
        );

    if (addFingerprint) {

        addFingerprint.onclick =
            addFingerprintModal;

    }


    // Telegram button now handled by attachTelegramEventListeners()

}


/* =====================================================
   SENSOR DATA FUNCTIONS
===================================================== */

async function fetchSensorData() {
    // Don't fetch if not authenticated
    if (!webAuthenticated) {
        return;
    }

    try {
        const response = await authenticatedFetch('/api/sensors/latest');

        if (response.ok) {
            const data = await response.json();

            // SECURITY: Don't log raw sensor data
        debugLog('Sensor data received:', data);

            // Backend ส่งมาเป็น { success: true, sensors: { dht22: { temperature, humidity } } }
            const sensorData = data.sensors?.dht22 || data;

            if (sensorData && sensorData.temperature !== undefined && sensorData.humidity !== undefined) {
                const temp = parseFloat(sensorData.temperature);
                const humidity = parseFloat(sensorData.humidity);

                // Add to history
                sensorData.temperatureHistory.push(temp);
                sensorData.humidityHistory.push(humidity);

                // Keep only last N readings
                if (sensorData.temperatureHistory.length > sensorData.maxHistorySize) {
                    sensorData.temperatureHistory.shift();
                }
                if (sensorData.humidityHistory.length > sensorData.maxHistorySize) {
                    sensorData.humidityHistory.shift();
                }

                // Calculate average
                const avgTemp = sensorData.temperatureHistory.reduce((a, b) => a + b, 0) / sensorData.temperatureHistory.length;
                const avgHumidity = sensorData.humidityHistory.reduce((a, b) => a + b, 0) / sensorData.humidityHistory.length;

                sensorData.temperature = avgTemp;
                sensorData.humidity = avgHumidity;
                sensorData.lastUpdate = new Date();

                debugLog('Averaged sensor data:', {
                    temperature: sensorData.temperature,
                    humidity: sensorData.humidity,
                    samples: sensorData.temperatureHistory.length
                });

                updateDashboardSensors();
            }
        }
    } catch (error) {
        console.error('Failed to fetch sensor data:', error.message);
    }
}

function updateDashboardSensors() {
    const tempElement = document.getElementById('dashboard-temperature');
    const humidityElement = document.getElementById('dashboard-humidity');

    // Don't log to reduce console spam
    // console.log('Updating dashboard sensors:', {...});

    if (tempElement) {
        const valueSpan = tempElement.querySelector('.sensor-value');
        if (valueSpan) {
            valueSpan.textContent = sensorData.temperature.toFixed(1);
        } else {
            // Fallback if span doesn't exist
            tempElement.innerHTML = `<span class="sensor-value">${sensorData.temperature.toFixed(1)}</span><small>°C</small>`;
        }
    }

    if (humidityElement) {
        const valueSpan = humidityElement.querySelector('.sensor-value');
        if (valueSpan) {
            valueSpan.textContent = Math.round(sensorData.humidity);
        } else {
            // Fallback if span doesn't exist
            humidityElement.innerHTML = `<span class="sensor-value">${Math.round(sensorData.humidity)}</span><small>%</small>`;
        }
    }

    // DO NOT call renderPage() here - it will recreate the entire page
}

async function fetchSystemStatus() {
    // Don't fetch if not authenticated
    if (!webAuthenticated) {
        return;
    }

    try {
        const response = await authenticatedFetch('/api/system/status');

        if (response.ok) {
            const data = await response.json();

            // Backend ส่งมาเป็น { success: true, mqtt: { connected: true }, esp32: { status: 'online' }, mysql: { connected: true }, uptime, timestamp }
            if (data && data.esp32) {
                // Update system status based on ESP32 actual status
                if (data.esp32.status === 'online') {
                    systemStatus.esp32 = true;
                } else {
                    systemStatus.esp32 = false;
                }

                // Update MQTT status
                if (data.mqtt) {
                    systemStatus.mqtt = data.mqtt.connected;
                }

                // Update MySQL status
                if (data.mysql) {
                    systemStatus.mysql = data.mysql.connected;
                }

                // Update Telegram status
                if (data.telegram) {
                    systemStatus.telegram = data.telegram.connected;
                }

                // Update ESP32 status badge directly
                updateSystemStatus();
            }
        }
    } catch (error) {
        console.error('Failed to fetch system status:', error);
        systemStatus.esp32 = false;
        systemStatus.mqtt = false;
        updateSystemStatus();
    }
}

// Start periodic updates
let sensorUpdateInterval = null;
let systemStatusInterval = null;

function startDashboardUpdates() {
    debugLog('[Dashboard] Starting dashboard updates...');
    debugLog('[Dashboard] Current page:', currentPage);

    // Fetch initial sensor data first
    fetchSensorData();
    fetchSystemStatus();

    // Set up periodic updates every 5 seconds
    if (sensorUpdateInterval) {
        clearInterval(sensorUpdateInterval);
    }
    sensorUpdateInterval = setInterval(fetchSensorData, 5000);

    if (systemStatusInterval) {
        clearInterval(systemStatusInterval);
    }
    systemStatusInterval = setInterval(fetchSystemStatus, 30000);

    debugLog('[Dashboard] Dashboard updates started');
}

function stopDashboardUpdates() {
    if (sensorUpdateInterval) {
        clearInterval(sensorUpdateInterval);
        sensorUpdateInterval = null;
    }

    if (systemStatusInterval) {
        clearInterval(systemStatusInterval);
        systemStatusInterval = null;
    }
}


/* =====================================================
   SCENE ACTION
===================================================== */

async function runScene(sceneId) {

    const scene =
        scenes.find(
            scene => scene.id === sceneId
        );


    if (!scene)
        return;


    showToast(
        `${scene.icon} ${scene.name} executed`
    );


    addLog(
        "living",
        `${scene.name} started`,
        '<span class="material-symbols-outlined">theater_comedy</span>'
    );

    // Use database-backed execution for scenes with valid DB IDs
    if (scene.dbId) {
        try {
            const response = await fetch(`/api/v2/scenes/${scene.dbId}/run`, {
                method: 'POST',
                credentials: 'include'
            });

            if (!response.ok) {
                if (response.status === 404) {
                    showToast('❌ Scene not found');
                } else if (response.status === 401) {
                    showToast('❌ Authentication required');
                } else {
                    showToast('❌ Failed to execute scene');
                }
                console.error('Scene execution failed:', response.status);
            }
        } catch (error) {
            console.error('Scene execution error:', error);
            showToast('❌ Network error');
        }

        renderPage();
        return;
    }

    // Legacy execution for scenes without DB ID (e.g., Cooking if it has no dbId)
    // Send MQTT command to ESP32
    const sceneMap = {
        'home': 'HOME',
        'exit': 'AWAY',
        'sleep': 'SLEEP',
        'wake': 'WAKEUP'
        // 'cooking' intentionally omitted - not part of Phase 2, stays inert
    };

    if (!sceneMap[sceneId]) {
        renderPage();
        return;
    }

    const mqttScene = sceneMap[sceneId] || 'HOME';
    await mqttClient.setScene(mqttScene);

    // Real device state now comes back via the existing WS state-sync path
    // (initial_state / mqtt_message handlers already write into `rooms`) -
    // no local optimistic mutation here anymore, avoids conflicting with
    // real ESP32-confirmed state.

    renderPage();

}


/* =====================================================
   FINGERPRINT SUCCESS
===================================================== */

function fingerprintSuccess() {

    failedAttempts = 0;


    addLog(
        "living",
        "Fingerprint Access Granted",
        '<span class="material-symbols-outlined">check_circle</span>'
    );


    showToast(
        '<span class="material-symbols-outlined">check_circle</span> Access Granted · Fingerprint ID 01'
    );


    renderPage();

}


/* =====================================================
   FINGERPRINT FAILED
===================================================== */

function fingerprintFailed() {

    failedAttempts++;


    addLog(
        "living",
        `Fingerprint Failed · ${failedAttempts}/3`,
        '<span class="material-symbols-outlined">cancel</span>'
    );


    showToast(
        `<span class="material-symbols-outlined">cancel</span> Fingerprint Failed · ${failedAttempts}/3`
    );


    if (failedAttempts >= 3) {

        failedAttempts = 0;

        setTimeout(() => {

            telegramAlert();

        }, 300);

    }


    renderPage();

}


/* =====================================================
   TELEGRAM ALERT
===================================================== */

function telegramAlert() {

    addLog(
        "living",
        "Telegram Security Alert Triggered",
        '<span class="material-symbols-outlined">emergency</span>'
    );


    showToast(
        '<span class="material-symbols-outlined">emergency</span> Telegram Alert Triggered'
    );


    openModal(`

        <div style="text-align:center">

            <div class="telegram-icon"
                 style="margin:auto">
                <span class="material-symbols-outlined">send</span>
            </div>

            <h2>
                Telegram Alert
            </h2>

            <p class="subtitle">

                Fingerprint authentication
                failed 3 consecutive times.

            </p>

            <p class="subtitle">

                Location:
                Main Door

            </p>

            <button
                class="primary-button"
                onclick="closeModal()"
            >
                CLOSE
            </button>

        </div>

    `);

}


/* =====================================================
   TEST TELEGRAM
===================================================== */

async function testTelegramReal() {
    const button = document.getElementById('test-telegram');
    if (!button) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'SENDING...';

    try {
        const response = await authenticatedFetch('/api/telegram/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.success) {
            showToast('Test notification sent successfully');
        } else {
            showToast('Failed to send test: ' + (data.message || 'Unknown error'));
        }
    } catch (err) {
        console.error('Error sending Telegram test:', err.message);
        showToast('Error sending test: ' + err.message);
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function testTelegram() {
    // Legacy function - redirect to real implementation
    testTelegramReal();
}


/* =====================================================
   ADD FINGERPRINT
===================================================== */

let pendingFingerprintData = null;

function addFingerprintModal() {

    const nextId = fingerprints.length + 1;

    openModal(`

        <h2>
            Add Fingerprint
        </h2>

        <p class="subtitle" style="margin-bottom: 20px;">
            Registering ID: <strong style="color: #3dd9bd;">#${nextId.toString().padStart(2, '0')}</strong>
        </p>

        <label>
            Name
        </label>

        <input
            id="fingerprint-name"
            placeholder="User name"
        >


        <label>
            Rank
        </label>

        <select id="fingerprint-rank">

            <option>
                User
            </option>

            <option>
                Administrator
            </option>

        </select>


        <div class="modal-buttons">

            <button
                class="secondary-button"
                onclick="closeModal()"
            >
                CANCEL
            </button>

            <button
                class="primary-button"
                onclick="goToScanFingerprint()"
            >
                NEXT
            </button>

        </div>

    `);

}

function goToScanFingerprint() {

    if (fingerprints.length >= 10) {

        showToast(
            "Maximum 10 fingerprints"
        );

        return;

    }

    const name =
        document.getElementById(
            "fingerprint-name"
        ).value
        || `User ${fingerprints.length + 1}`;


    const rank =
        document.getElementById(
            "fingerprint-rank"
        ).value;

    // Store pending data
    pendingFingerprintData = {
        id: fingerprints.length + 1,
        name: name,
        rank: rank,
        status: "Active"
    };

    // Show scan screen
    openModal(`

        <h2>
            Scan Fingerprint
        </h2>

        <p class="subtitle">
            ID: <strong style="color: #3dd9bd;">#${pendingFingerprintData.id.toString().padStart(2, '0')}</strong> · ${pendingFingerprintData.name}
        </p>

        <div style="text-align: center; padding: 40px 20px;">
            <div style="position: relative; display: inline-block;">
                <div class="fingerprint-scan-pulse"></div>
                <span class="material-symbols-outlined" style="font-size: 80px; color: #3dd9bd; position: relative; z-index: 2;">fingerprint</span>
            </div>
            <p style="font-size: 14px; color: #8a9199; margin: 30px 0 20px;">
                Please place your finger on the sensor
            </p>
            <div style="display: flex; gap: 10px; justify-content: center; align-items: center;">
                <div class="scan-dot"></div>
                <div class="scan-dot"></div>
                <div class="scan-dot"></div>
            </div>
        </div>

        <div class="modal-buttons">

            <button
                class="secondary-button"
                onclick="closeModal(); pendingFingerprintData = null;"
            >
                CANCEL
            </button>

            <button
                class="primary-button"
                onclick="saveFingerprint()"
            >
                SIMULATE SCAN
            </button>

        </div>

    `);

}


function saveFingerprint() {

    if (!pendingFingerprintData) {
        showToast("No fingerprint data to save");
        return;
    }

    // Show success animation
    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');

    if (modal && modalContent) {
        // Add success border flash effect
        modalContent.classList.add('scan-success');

        // Update modal content to show success
        modalContent.innerHTML = `
            <h2>
                Scan Complete
            </h2>

            <p class="subtitle">
                ID: <strong style="color: #4ee8ca;">#${pendingFingerprintData.id.toString().padStart(2, '0')}</strong> · ${pendingFingerprintData.name}
            </p>

            <div style="text-align: center; padding: 40px 20px;">
                <div class="success-checkmark">
                    <span class="material-symbols-outlined" style="font-size: 80px; color: #4ee8ca;">check_circle</span>
                </div>
                <p style="font-size: 14px; color: #4ee8ca; margin-top: 20px; font-weight: 600;">
                    Fingerprint registered successfully!
                </p>
            </div>
        `;

        // Wait for animation then save
        setTimeout(() => {
            fingerprints.push(pendingFingerprintData);

            closeModal();

            showToast(
                `<span class="material-symbols-outlined">check_circle</span> Fingerprint #${pendingFingerprintData.id.toString().padStart(2, '0')} added`
            );

            pendingFingerprintData = null;

            renderPage();
        }, 2000);
    } else {
        // Fallback if modal elements not found
        fingerprints.push(pendingFingerprintData);

        closeModal();

        showToast(
            `<span class="material-symbols-outlined">check_circle</span> Fingerprint #${pendingFingerprintData.id.toString().padStart(2, '0')} added`
        );

        pendingFingerprintData = null;

        renderPage();
    }

}


function deleteFingerprint(id) {

    openModal(`

        <h2>
            Delete Fingerprint
        </h2>

        <p class="subtitle" style="margin-bottom: 20px;">
            Are you sure you want to delete fingerprint <strong style="color: #ff6b6b;">#${id.toString().padStart(2, '0')}</strong>?
        </p>

        <div class="modal-buttons">

            <button
                class="secondary-button"
                onclick="closeModal()"
            >
                CANCEL
            </button>

            <button
                class="danger-button"
                onclick="confirmDeleteFingerprint(${id})"
            >
                DELETE
            </button>

        </div>

    `);

}


function confirmDeleteFingerprint(id) {
    closeModal();

    // Check admin authorization
    authenticatedFetch('/api/fingerprint/admin/status')
        .then(res => res.json())
        .then(data => {
            if (!data.authorized) {
                showToast('Admin authorization required');
                return;
            }

            // Proceed with deletion
            performDeletion(id);
        })
        .catch(err => {
            console.error('Error checking admin status:', err.message);
            showToast('Failed to verify admin authorization');
        });
}

async function performDeletion(id) {
    try {
        const response = await fetch(`/api/fingerprint/users/${id}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showToast(`Fingerprint ID ${id} deletion in progress...`);
        } else {
            showToast(data.message || 'Deletion failed');
        }
    } catch (err) {
        console.error('Error deleting fingerprint:', err.message);
        showToast('Failed to delete fingerprint');
    }
}


function editFingerprint(id) {

    const fingerprint = fingerprints.find(fp => fp.id === id);

    if (!fingerprint) return;

    openModal(`

        <h2>
            Edit Fingerprint
        </h2>

        <p class="subtitle" style="margin-bottom: 20px;">
            ID: <strong style="color: #3dd9bd;">#${id.toString().padStart(2, '0')}</strong>
        </p>

        <label>
            Name
        </label>

        <input
            id="edit-fingerprint-name"
            value="${fingerprint.name}"
            placeholder="User name"
        >


        <label>
            Rank
        </label>

        <select id="edit-fingerprint-rank">

            <option ${fingerprint.rank === 'User' ? 'selected' : ''}>
                User
            </option>

            <option ${fingerprint.rank === 'Administrator' ? 'selected' : ''}>
                Administrator
            </option>

        </select>


        <div class="modal-buttons">

            <button
                class="secondary-button"
                onclick="closeModal()"
            >
                CANCEL
            </button>

            <button
                class="primary-button"
                onclick="saveEditFingerprint(${id})"
            >
                SAVE
            </button>

        </div>

    `);

}


function saveEditFingerprint(id) {

    const fingerprint = fingerprints.find(fp => fp.id === id);

    if (!fingerprint) return;

    const name = document.getElementById("edit-fingerprint-name").value || fingerprint.name;
    const rank = document.getElementById("edit-fingerprint-rank").value;

    fingerprint.name = name;
    fingerprint.rank = rank;

    closeModal();

    showToast(
        `<span class="material-symbols-outlined">check_circle</span> Fingerprint #${id.toString().padStart(2, '0')} updated`
    );

    renderPage();

}


/* =====================================================
   CREATE SCENE
===================================================== */

// State for managing dynamic action rows
let sceneActionRows = [];
let nextActionId = 1;
let editingSceneId = null; // Track if we're in edit mode

function createSceneModal() {
    // Reset action rows and editing state
    editingSceneId = null;
    sceneActionRows = [{ id: nextActionId++, order: 1 }];

    openModal(`
        <h2>Create Scene</h2>

        <div class="modal-scrollable-content">
            <div class="edit-modal-layout">
                <div class="edit-modal-left">
                    <h3 style="margin-bottom: 16px; font-size: 14px; color: #b8c7c4;">Scene Information</h3>

                    <div class="form-group">
                        <label for="scene-name">Scene Name <span style="color: #ff6b6b;">*</span></label>
                        <input
                            type="text"
                            id="scene-name"
                            placeholder="Enter scene name..."
                            maxlength="100"
                            required
                        >
                    </div>

                    <div class="form-group">
                        <label for="scene-description">Description (optional)</label>
                        <textarea
                            id="scene-description"
                            placeholder="Describe what this scene does..."
                            maxlength="255"
                            rows="3"
                        ></textarea>
                    </div>

                    <div class="form-group">
                        <label for="scene-icon">Icon (optional)</label>
                        <div class="scene-icon-selector">
                            <div class="scene-icon-preview" id="scene-icon-preview" onclick="toggleIconDropdown()">
                                <span class="material-symbols-outlined">routine</span>
                            </div>
                            <input type="hidden" id="scene-icon" value="routine">
                            <div class="scene-icon-dropdown" id="scene-icon-dropdown" style="display: none;">
                                ${['routine', 'home', 'bedtime', 'light_mode', 'movie', 'music_note', 'restaurant', 'local_dining', 'work', 'school', 'fitness_center', 'cleaning_services', 'lock', 'logout', 'celebration', 'weekend', 'nightlight', 'thermostat', 'power'].map(icon => `
                                    <div class="scene-icon-option" onclick="selectSceneIcon('${icon}')">
                                        <span class="material-symbols-outlined">${icon}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <small style="color: #8a9d9a; font-size: 11px;">Choose an icon for this scene</small>
                    </div>
                </div>

                <div class="edit-modal-right">
                    <h3 style="margin-bottom: 16px; font-size: 14px; color: #b8c7c4;">Actions <span style="color: #ff6b6b;">*</span></h3>

                    <div class="edit-modal-actions-scroll">
                        <div id="action-rows-container"></div>
                    </div>

                    <button
                        type="button"
                        class="secondary-button"
                        onclick="addActionRow()"
                        style="margin-top: 12px; width: 100%;"
                    >
                        + Add Action
                    </button>
                </div>
            </div>

            <div id="create-scene-error" style="color: #ff6b6b; margin-top: 12px; display: none;"></div>
        </div>

        <div class="modal-buttons">
            <button
                type="button"
                class="secondary-button"
                onclick="closeModal()"
            >
                CANCEL
            </button>
            <button
                type="button"
                class="primary-button"
                onclick="saveScene()"
            >
                SAVE SCENE
            </button>
        </div>
    `);

    renderActionRows();
}

async function editSceneModal(sceneId) {
    try {
        // Fetch scene data from API
        const response = await fetch(`/api/v2/scenes/${sceneId}`, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            if (response.status === 401) {
                showToast('❌ Authentication required');
                return;
            }
            if (response.status === 404) {
                showToast('❌ Scene not found');
                return;
            }
            throw new Error(`Failed to load scene: ${response.status}`);
        }

        const data = await response.json();
        const scene = data.scene;

        // Set editing mode
        editingSceneId = sceneId;

        // Initialize action rows from existing scene actions
        sceneActionRows = scene.actions.map((action, index) => ({
            id: nextActionId++,
            order: action.execution_order,
            data: action
        }));

        // Open modal with pre-filled data
        openModal(`
            <h2>Edit Scene</h2>

            <div class="modal-scrollable-content">
                <div class="edit-modal-layout">
                    <div class="edit-modal-left">
                        <h3 style="margin-bottom: 16px; font-size: 14px; color: #b8c7c4;">Scene Information</h3>

                        <div class="form-group">
                            <label for="scene-name">Scene Name <span style="color: #ff6b6b;">*</span></label>
                            <input
                                type="text"
                                id="scene-name"
                                placeholder="Movie Night"
                                maxlength="100"
                                value="${escapeHtml(scene.name)}"
                                required
                            >
                        </div>

                        <div class="form-group">
                            <label for="scene-description">Description (optional)</label>
                            <textarea
                                id="scene-description"
                                placeholder="Describe what this scene does..."
                                maxlength="255"
                                rows="3"
                            >${escapeHtml(scene.description || '')}</textarea>
                        </div>

                        <div class="form-group">
                            <label for="scene-icon">Icon (optional)</label>
                            <input
                                type="text"
                                id="scene-icon"
                                placeholder="🎬 or text"
                                maxlength="50"
                                value="${escapeHtml(scene.icon || '')}"
                            >
                            <small style="color: #8a9d9a; font-size: 11px;">Enter emoji or short text</small>
                        </div>

                        ${scene.id === 3 ? `
                        <div class="form-group" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #1c2525;">
                            <h3 style="margin-bottom: 12px; font-size: 14px; color: #b8c7c4;">Sleep Timer</h3>

                            <div class="timer-toggle-container">
                                <div class="timer-toggle-switch ${scene.timer_enabled ? 'active' : ''}" id="timer-toggle" onclick="toggleTimer('timer')">
                                    <div class="timer-toggle-slider"></div>
                                </div>
                                <span class="timer-toggle-label" onclick="toggleTimer('timer')">Automatically run Wake Up after timer</span>
                            </div>

                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div>
                                    <label for="timer-minutes" style="font-size: 12px; color: #8a9d9a;">Minutes</label>
                                    <input
                                        type="number"
                                        id="timer-minutes"
                                        min="0"
                                        value="${scene.timer_minutes || 0}"
                                        ${!scene.timer_enabled ? 'disabled' : ''}
                                        style="width: 100%; padding: 8px; background: #141b1c; border: 1px solid #1c2525; border-radius: 6px; color: #fff;"
                                    >
                                </div>
                                <div>
                                    <label for="timer-seconds" style="font-size: 12px; color: #8a9d9a;">Seconds (0-59)</label>
                                    <input
                                        type="number"
                                        id="timer-seconds"
                                        min="0"
                                        max="59"
                                        value="${scene.timer_seconds || 0}"
                                        ${!scene.timer_enabled ? 'disabled' : ''}
                                        style="width: 100%; padding: 8px; background: #141b1c; border: 1px solid #1c2525; border-radius: 6px; color: #fff;"
                                    >
                                </div>
                            </div>
                            <small style="color: #8a9d9a; font-size: 11px; display: block; margin-top: 8px;">After this scene runs, Wake Up will execute automatically</small>
                        </div>
                        ` : ''}

                        ${scene.id === 4 ? `
                        <div class="form-group" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #1c2525;">
                            <h3 style="margin-bottom: 12px; font-size: 14px; color: #b8c7c4;">Home Timer</h3>

                            <div class="timer-toggle-container">
                                <div class="timer-toggle-switch ${scene.wake_home_timer_enabled ? 'active' : ''}" id="wake-home-timer-toggle" onclick="toggleTimer('wake-home-timer')">
                                    <div class="timer-toggle-slider"></div>
                                </div>
                                <span class="timer-toggle-label" onclick="toggleTimer('wake-home-timer')">Automatically run Home after this timer</span>
                            </div>

                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div>
                                    <label for="wake-home-timer-minutes" style="font-size: 12px; color: #8a9d9a;">Minutes</label>
                                    <input
                                        type="number"
                                        id="wake-home-timer-minutes"
                                        min="0"
                                        value="${scene.wake_home_timer_minutes || 0}"
                                        ${!scene.wake_home_timer_enabled ? 'disabled' : ''}
                                        style="width: 100%; padding: 8px; background: #141b1c; border: 1px solid #1c2525; border-radius: 6px; color: #fff;"
                                    >
                                </div>
                                <div>
                                    <label for="wake-home-timer-seconds" style="font-size: 12px; color: #8a9d9a;">Seconds (0-59)</label>
                                    <input
                                        type="number"
                                        id="wake-home-timer-seconds"
                                        min="0"
                                        max="59"
                                        value="${scene.wake_home_timer_seconds || 0}"
                                        ${!scene.wake_home_timer_enabled ? 'disabled' : ''}
                                        style="width: 100%; padding: 8px; background: #141b1c; border: 1px solid #1c2525; border-radius: 6px; color: #fff;"
                                    >
                                </div>
                            </div>
                            <small style="color: #8a9d9a; font-size: 11px; display: block; margin-top: 8px;">After this scene runs, Home will execute automatically</small>
                        </div>
                        ` : ''}
                    </div>

                    <div class="edit-modal-right">
                        <h3 style="margin-bottom: 16px; font-size: 14px; color: #b8c7c4;">Actions <span style="color: #ff6b6b;">*</span></h3>

                        <div class="edit-modal-actions-scroll">
                            <div id="action-rows-container"></div>
                        </div>

                        <button
                            type="button"
                            class="secondary-button"
                            onclick="addActionRow()"
                            style="margin-top: 12px; width: 100%;"
                        >
                            + Add Action
                        </button>
                    </div>
                </div>

                <div id="create-scene-error" style="color: #ff6b6b; margin-top: 12px; display: none;"></div>
            </div>

            <div class="modal-buttons">
                <button
                    type="button"
                    class="secondary-button"
                    onclick="closeModal()"
                >
                    CANCEL
                </button>
                <button
                    type="button"
                    class="primary-button"
                    onclick="saveScene()"
                >
                    SAVE CHANGES
                </button>
            </div>
        `);

        renderActionRows();

    } catch (error) {
        console.error('Failed to load scene for editing:', error);
        showToast('❌ Failed to load scene');
    }
}

// Timer Toggle Function
function toggleTimer(timerType) {
    const toggleSwitch = document.getElementById(`${timerType}-toggle`);
    const minutesInput = document.getElementById(`${timerType}-minutes`);
    const secondsInput = document.getElementById(`${timerType}-seconds`);

    if (!toggleSwitch || !minutesInput || !secondsInput) return;

    // Toggle the active state
    const isActive = toggleSwitch.classList.contains('active');

    if (isActive) {
        // Turn OFF
        toggleSwitch.classList.remove('active');
        minutesInput.disabled = true;
        secondsInput.disabled = true;
    } else {
        // Turn ON
        toggleSwitch.classList.add('active');
        minutesInput.disabled = false;
        secondsInput.disabled = false;
    }
}

// Helper function to escape HTML
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

// Custom Dropdown Component Generator
function createCustomDropdown(className, actionId, options, selectedValue, isDisabled = false) {
    const selectedOption = options.find(opt => opt.value === selectedValue) || options[0];
    const dropdownId = `${className}-${actionId}`;

    return `
        <div class="custom-dropdown ${className}" data-action-id="${actionId}" data-dropdown-id="${dropdownId}" ${isDisabled ? 'data-disabled="true"' : ''}>
            <div class="custom-dropdown-selected" onclick="toggleCustomDropdown('${dropdownId}')">
                <span>${selectedOption.label}</span>
                <svg class="custom-dropdown-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none">
                    <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <div class="custom-dropdown-menu">
                ${options.map(opt => `
                    <div class="custom-dropdown-option ${opt.value === selectedValue ? 'selected' : ''}"
                         data-value="${opt.value}"
                         onclick="selectCustomDropdownOption('${dropdownId}', '${opt.value}', '${opt.label}')">
                        ${opt.label}
                    </div>
                `).join('')}
            </div>
            <input type="hidden" class="${className}" data-action-id="${actionId}" value="${selectedValue}">
        </div>
    `;
}

// Toggle dropdown open/close
function toggleCustomDropdown(dropdownId) {
    const dropdown = document.querySelector(`[data-dropdown-id="${dropdownId}"]`);
    if (!dropdown || dropdown.dataset.disabled === 'true') return;

    const isOpen = dropdown.classList.contains('open');

    // Close all other dropdowns
    document.querySelectorAll('.custom-dropdown.open').forEach(d => {
        d.classList.remove('open');
    });

    // Toggle this dropdown
    if (!isOpen) {
        dropdown.classList.add('open');
    }
}

// Select option in dropdown
function selectCustomDropdownOption(dropdownId, value, label) {
    const dropdown = document.querySelector(`[data-dropdown-id="${dropdownId}"]`);
    if (!dropdown) {
        console.error('Dropdown not found:', dropdownId);
        return;
    }

    // Update displayed text
    const selectedDiv = dropdown.querySelector('.custom-dropdown-selected span');
    if (selectedDiv) selectedDiv.textContent = label;

    // Update hidden input
    const hiddenInput = dropdown.querySelector('input[type="hidden"]');
    if (hiddenInput) {
        hiddenInput.value = value;
        console.log('Updated hidden input:', hiddenInput.id, '=', value);
    } else {
        console.warn('Hidden input not found in dropdown:', dropdownId);
    }

    // Update selected state in menu
    dropdown.querySelectorAll('.custom-dropdown-option').forEach(opt => {
        opt.classList.remove('selected');
        if (opt.dataset.value === value) {
            opt.classList.add('selected');
        }
    });

    // Close dropdown
    dropdown.classList.remove('open');

    // Trigger device type change if this is a device-type dropdown
    if (dropdown.classList.contains('action-device-type')) {
        const actionId = dropdown.dataset.actionId;
        handleDeviceTypeChange(parseInt(actionId));
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(e) {
    if (!e.target.closest('.custom-dropdown')) {
        document.querySelectorAll('.custom-dropdown.open').forEach(d => {
            d.classList.remove('open');
        });
    }
});

function generateValueControl(actionId, data) {
    const deviceType = data.device_type || '';
    const actionType = data.action_type || '';
    const value = data.action_value !== undefined ? data.action_value : '';

    // LED/Fan state → ON/OFF custom dropdown
    if ((deviceType === 'led' || deviceType === 'fan') && actionType === 'state') {
        const options = [
            { value: '', label: 'Select...' },
            { value: 'true', label: 'ON' },
            { value: 'false', label: 'OFF' }
        ];
        const selectedValue = value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : '';
        return createCustomDropdown('action-value', actionId, options, selectedValue);
    }

    // AC level → OFF/SLEEP/COOL/COOLER custom dropdown
    if (deviceType === 'ac' && actionType === 'level') {
        const options = [
            { value: '', label: 'Select...' },
            { value: '0', label: 'OFF' },
            { value: '1', label: 'SLEEP' },
            { value: '2', label: 'COOL' },
            { value: '3', label: 'COOLER' }
        ];
        const selectedValue = value !== undefined ? String(value) : '';
        return createCustomDropdown('action-value', actionId, options, selectedValue);
    }

    // Door mode → unlock/lock custom dropdown
    if (deviceType === 'door' && actionType === 'mode') {
        const options = [
            { value: '', label: 'Select...' },
            { value: 'unlock', label: 'UNLOCK' },
            { value: 'lock', label: 'LOCK' }
        ];
        return createCustomDropdown('action-value', actionId, options, value);
    }

    // Auto Mode → on/off custom dropdown
    if (deviceType === 'auto_mode' && actionType === 'mode') {
        const options = [
            { value: '', label: 'Select...' },
            { value: 'on', label: 'ON' },
            { value: 'off', label: 'OFF' }
        ];
        return createCustomDropdown('action-value', actionId, options, value);
    }

    // Window angle → number input (keep as-is)
    if (deviceType === 'window' && actionType === 'angle') {
        return `<input type="number" class="action-value" data-action-id="${actionId}"
            min="0" max="180" placeholder="0-180" value="${value}">`;
    }

    // Default fallback → text input
    const placeholder = deviceType === 'auto_mode' ? 'on/off' : 'true/false or number';
    return `<input type="text" class="action-value" data-action-id="${actionId}"
        placeholder="${placeholder}" value="${value}">`;
}

function renderActionRows() {
    const container = document.getElementById('action-rows-container');
    if (!container) return;

    container.innerHTML = sceneActionRows.map((row, index) => {
        const data = row.data || {};
        const isAutoMode = data.device_type === 'auto_mode';

        // Device Type options
        const deviceTypeOptions = [
            { value: '', label: 'Select...' },
            { value: 'led', label: 'LED' },
            { value: 'fan', label: 'Fan' },
            { value: 'ac', label: 'AC' },
            { value: 'window', label: 'Window' },
            { value: 'door', label: 'Door' },
            { value: 'auto_mode', label: 'Auto Mode' }
        ];

        // Room options
        const roomOptions = [
            { value: '', label: 'Select...' },
            { value: 'living', label: 'Living' },
            { value: 'kitchen', label: 'Kitchen' },
            { value: 'bedroom', label: 'Bedroom' }
        ];

        // Action Type options
        const actionTypeOptions = [
            { value: '', label: 'Select...' },
            { value: 'state', label: 'State' },
            { value: 'level', label: 'Level' },
            { value: 'angle', label: 'Angle' },
            { value: 'mode', label: 'Mode' }
        ];

        return `
        <div class="action-row" data-action-id="${row.id}" style="background: #0f1514; border: 1px solid #1c2525; border-radius: 8px; padding: 12px; margin-bottom: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <strong style="font-size: 12px; color: #8a9d9a;">Action ${index + 1}</strong>
                ${sceneActionRows.length > 1 ? `
                    <button
                        type="button"
                        onclick="removeActionRow(${row.id})"
                        style="background: transparent; border: none; color: #ff6b6b; cursor: pointer; padding: 4px; font-size: 18px;"
                        title="Remove action"
                    >×</button>
                ` : ''}
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div>
                    <label style="font-size: 11px; color: #8a9d9a; display: block; margin-bottom: 4px;">Device Type</label>
                    ${createCustomDropdown('action-device-type', row.id, deviceTypeOptions, data.device_type || '')}
                </div>

                <div>
                    <label style="font-size: 11px; color: #8a9d9a; display: block; margin-bottom: 4px;">Room${isAutoMode ? ' (N/A)' : ''}</label>
                    ${createCustomDropdown('action-room', row.id, roomOptions, data.room || '', isAutoMode)}
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div>
                    <label style="font-size: 11px; color: #8a9d9a; display: block; margin-bottom: 4px;">Action Type</label>
                    ${createCustomDropdown('action-type', row.id, actionTypeOptions, data.action_type || '')}
                </div>

                <div>
                    <label style="font-size: 11px; color: #8a9d9a; display: block; margin-bottom: 4px;">Value</label>
                    ${generateValueControl(row.id, data)}
                </div>
            </div>

            <input type="hidden" class="action-order" data-action-id="${row.id}" value="${row.order}">
        </div>
    `;
    }).join('');
}

function captureActionRowsFromDOM() {
    sceneActionRows.forEach(row => {
        // For custom dropdowns, get the hidden input value
        const deviceTypeInput = document.querySelector(`.custom-dropdown.action-device-type[data-action-id="${row.id}"] input[type="hidden"]`);
        const roomInput = document.querySelector(`.custom-dropdown.action-room[data-action-id="${row.id}"] input[type="hidden"]`);
        const actionTypeInput = document.querySelector(`.custom-dropdown.action-type[data-action-id="${row.id}"] input[type="hidden"]`);

        // For value controls, check if it's a custom dropdown or regular input
        let actionValueInput = document.querySelector(`.custom-dropdown.action-value[data-action-id="${row.id}"] input[type="hidden"]`);
        if (!actionValueInput) {
            // Fallback to regular input (number/text input for window angle or default)
            actionValueInput = document.querySelector(`.action-value[data-action-id="${row.id}"]`);
        }

        if (deviceTypeInput && actionTypeInput && actionValueInput) {
            row.data = {
                device_type: deviceTypeInput.value,
                room: roomInput ? roomInput.value : null,
                action_type: actionTypeInput.value,
                action_value: actionValueInput.value
            };
        }
    });
}

function addActionRow() {
    captureActionRowsFromDOM();
    const newOrder = sceneActionRows.length + 1;
    sceneActionRows.push({ id: nextActionId++, order: newOrder });
    renderActionRows();
}

function removeActionRow(actionId) {
    captureActionRowsFromDOM();
    sceneActionRows = sceneActionRows.filter(row => row.id !== actionId);
    // Reorder remaining actions
    sceneActionRows.forEach((row, index) => {
        row.order = index + 1;
    });
    renderActionRows();
}

function handleDeviceTypeChange(actionId) {
    // For custom dropdowns, get the hidden input value
    const deviceTypeInput = document.querySelector(`.custom-dropdown.action-device-type[data-action-id="${actionId}"] input[type="hidden"]`);
    const roomDropdown = document.querySelector(`.custom-dropdown.action-room[data-action-id="${actionId}"]`);
    const actionTypeInput = document.querySelector(`.custom-dropdown.action-type[data-action-id="${actionId}"] input[type="hidden"]`);

    if (!deviceTypeInput || !roomDropdown || !actionTypeInput) return;

    const deviceType = deviceTypeInput.value;

    // Auto mode doesn't need a room
    if (deviceType === 'auto_mode') {
        roomDropdown.dataset.disabled = 'true';
        const roomInput = roomDropdown.querySelector('input[type="hidden"]');
        if (roomInput) roomInput.value = '';
    } else {
        roomDropdown.dataset.disabled = 'false';
    }

    // Set the correct action type based on device type
    let newActionType = '';
    switch (deviceType) {
        case 'led':
        case 'fan':
            newActionType = 'state';
            break;
        case 'ac':
            newActionType = 'level';
            break;
        case 'window':
            newActionType = 'angle';
            break;
        case 'door':
        case 'auto_mode':
            newActionType = 'mode';
            break;
        default:
            newActionType = '';
    }

    // Update action type select
    actionTypeInput.value = newActionType;

    // Update the displayed label in the action type dropdown
    const actionTypeDropdown = document.querySelector(`.custom-dropdown.action-type[data-action-id="${actionId}"]`);
    if (actionTypeDropdown) {
        const selectedSpan = actionTypeDropdown.querySelector('.custom-dropdown-selected span');
        const actionTypeLabels = {
            'state': 'State',
            'level': 'Level',
            'angle': 'Angle',
            'mode': 'Mode',
            '': 'Select...'
        };
        if (selectedSpan) {
            selectedSpan.textContent = actionTypeLabels[newActionType] || 'Select...';
        }
    }

    // Capture current state and regenerate value control
    captureActionRowsFromDOM();

    // Find the row and clear the action_value since we're changing the control type
    const row = sceneActionRows.find(r => r.id === actionId);
    if (row && row.data) {
        row.data.action_type = newActionType;
        row.data.action_value = '';
    }

    // Re-render to update the value control
    renderActionRows();
}

async function saveScene() {
    const errorDiv = document.getElementById('create-scene-error');

    // Get form values
    const name = document.getElementById('scene-name').value.trim();
    const description = document.getElementById('scene-description').value.trim();
    const icon = document.getElementById('scene-icon').value.trim();

    // Validate name
    if (!name) {
        errorDiv.textContent = 'Scene name is required';
        errorDiv.style.display = 'block';
        return;
    }

    if (name.length > 100) {
        errorDiv.textContent = 'Scene name must be 100 characters or less';
        errorDiv.style.display = 'block';
        return;
    }

    // Collect actions from form
    const actions = [];

    for (const row of sceneActionRows) {
        // For custom dropdowns, get the hidden input value
        const deviceTypeInput = document.querySelector(`.custom-dropdown.action-device-type[data-action-id="${row.id}"] input[type="hidden"]`);
        const roomInput = document.querySelector(`.custom-dropdown.action-room[data-action-id="${row.id}"] input[type="hidden"]`);
        const actionTypeInput = document.querySelector(`.custom-dropdown.action-type[data-action-id="${row.id}"] input[type="hidden"]`);

        // For value, check if it's a custom dropdown or regular input
        let actionValueInput = document.querySelector(`.custom-dropdown.action-value[data-action-id="${row.id}"] input[type="hidden"]`);
        if (!actionValueInput) {
            actionValueInput = document.querySelector(`.action-value[data-action-id="${row.id}"]`);
        }

        const orderInput = document.querySelector(`.action-order[data-action-id="${row.id}"]`);

        const deviceType = deviceTypeInput?.value;
        const room = roomInput?.value;
        const actionType = actionTypeInput?.value;
        const actionValueRaw = actionValueInput?.value;
        const order = parseInt(orderInput?.value);

        // Validate required fields
        // auto_mode doesn't require a room
        const isAutoMode = deviceType === 'auto_mode';

        if (!deviceType || !actionType || actionValueRaw === '') {
            errorDiv.textContent = `Action ${row.order}: Device Type, Action Type, and Value are required`;
            errorDiv.style.display = 'block';
            return;
        }

        if (!isAutoMode && !room) {
            errorDiv.textContent = `Action ${row.order}: Room is required for ${deviceType}`;
            errorDiv.style.display = 'block';
            return;
        }

        // Parse action_value (handle boolean strings and numbers)
        let actionValue = actionValueRaw.trim();
        if (actionValue === 'true') actionValue = true;
        else if (actionValue === 'false') actionValue = false;
        else if (!isNaN(actionValue)) actionValue = Number(actionValue);

        actions.push({
            device_type: deviceType,
            room: isAutoMode ? null : room,
            action_type: actionType,
            action_value: actionValue,
            execution_order: order
        });
    }

    if (actions.length === 0) {
        errorDiv.textContent = 'At least one action is required';
        errorDiv.style.display = 'block';
        return;
    }

    // Get timer configuration based on scene ID
    const sceneId = editingSceneId;
    let timerEnabled = false;
    let timerMinutes = 0;
    let timerSeconds = 0;
    let wakeHomeTimerEnabled = undefined;
    let wakeHomeTimerMinutes = undefined;
    let wakeHomeTimerSeconds = undefined;

    // Scene 3 (Sleep Mode) uses Sleep Timer
    if (sceneId === 3) {
        const timerToggle = document.getElementById('timer-toggle');
        timerEnabled = timerToggle ? timerToggle.classList.contains('active') : false;
        timerMinutes = parseInt(document.getElementById('timer-minutes')?.value || 0);
        timerSeconds = parseInt(document.getElementById('timer-seconds')?.value || 0);

        // Validate Sleep Timer values
        if (timerSeconds < 0 || timerSeconds > 59) {
            errorDiv.textContent = 'Sleep Timer seconds must be between 0 and 59';
            errorDiv.style.display = 'block';
            return;
        }

        if (timerMinutes < 0) {
            errorDiv.textContent = 'Sleep Timer minutes must be non-negative';
            errorDiv.style.display = 'block';
            return;
        }

        // If Sleep Timer is enabled, duration must be greater than 0
        if (timerEnabled && timerMinutes === 0 && timerSeconds === 0) {
            errorDiv.textContent = 'Sleep Timer duration must be greater than 0 when timer is enabled';
            errorDiv.style.display = 'block';
            return;
        }
    }
    // Scene 4 (Wake Up) uses Wake→Home Timer
    else if (sceneId === 4) {
        const wakeHomeTimerToggle = document.getElementById('wake-home-timer-toggle');
        wakeHomeTimerEnabled = wakeHomeTimerToggle ? wakeHomeTimerToggle.classList.contains('active') : false;
        wakeHomeTimerMinutes = parseInt(document.getElementById('wake-home-timer-minutes')?.value || 0);
        wakeHomeTimerSeconds = parseInt(document.getElementById('wake-home-timer-seconds')?.value || 0);

        // Validate Wake→Home Timer values
        if (wakeHomeTimerSeconds < 0 || wakeHomeTimerSeconds > 59) {
            errorDiv.textContent = 'Home Timer seconds must be between 0 and 59';
            errorDiv.style.display = 'block';
            return;
        }

        if (wakeHomeTimerMinutes < 0) {
            errorDiv.textContent = 'Home Timer minutes must be non-negative';
            errorDiv.style.display = 'block';
            return;
        }

        // If Wake→Home Timer is enabled, duration must be greater than 0
        if (wakeHomeTimerEnabled && wakeHomeTimerMinutes === 0 && wakeHomeTimerSeconds === 0) {
            errorDiv.textContent = 'Home Timer duration must be greater than 0 when timer is enabled';
            errorDiv.style.display = 'block';
            return;
        }
    }

    // Build payload
    // Convert icon name to Material Symbol HTML format for storage
    let iconHTML = null;
    if (icon) {
        // If it's already HTML (from Edit Scene), keep it
        if (icon.includes('<')) {
            iconHTML = icon;
        } else {
            // Convert icon name to Material Symbol HTML
            iconHTML = `<span class="material-symbols-outlined">${icon}</span>`;
        }
    }

    const payload = {
        name: name,
        description: description || null,
        icon: iconHTML,
        actions: actions,
        timer_enabled: timerEnabled,
        timer_minutes: timerMinutes,
        timer_seconds: timerSeconds
    };

    // Add Wake→Home timer fields only for Wake Up scene
    if (sceneId === 4) {
        payload.wake_home_timer_enabled = wakeHomeTimerEnabled;
        payload.wake_home_timer_minutes = wakeHomeTimerMinutes;
        payload.wake_home_timer_seconds = wakeHomeTimerSeconds;
    }

    // Hide previous errors
    errorDiv.style.display = 'none';

    try {
        // Determine if we're creating or editing
        const isEditing = editingSceneId !== null;
        const url = isEditing ? `/api/v2/scenes/${editingSceneId}` : '/api/v2/scenes';
        const method = isEditing ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (response.status === 401) {
            errorDiv.textContent = 'Authentication required. Please log in again.';
            errorDiv.style.display = 'block';
            return;
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            errorDiv.textContent = errorData.error || `Failed to ${isEditing ? 'update' : 'create'} scene (HTTP ${response.status})`;
            errorDiv.style.display = 'block';
            return;
        }

        // Success - close modal and refresh
        closeModal();

        // Reset editing state
        editingSceneId = null;

        // Reload scenes from API
        await loadScenes();

        // Re-render page content
        const content = document.getElementById('page-content');
        content.innerHTML = scenesHTML();

        // Re-bind event listeners
        bindDynamicButtons();

        // Show success toast
        showToast(isEditing ? '✓ Scene updated successfully' : '✓ Scene created successfully');

    } catch (error) {
        console.error('Failed to save scene:', error);
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.style.display = 'block';
    }
}


/**
 * Delete a scene - Show confirmation modal
 * @param {number} sceneId - Database scene ID to delete
 */
function deleteScene(sceneId) {
    // Find scene name for confirmation message
    const scene = scenes.find(s => s.dbId === sceneId);
    const sceneName = scene ? scene.name : 'this scene';

    // Open custom confirmation modal
    openModal(`
        <h2>Delete Scene</h2>

        <p class="subtitle" style="margin-bottom: 8px;">
            Are you sure you want to delete <strong style="color: #ff6b6b;">"${sceneName}"</strong>?
        </p>

        <p class="subtitle" style="margin-bottom: 20px; opacity: 0.7;">
            This action cannot be undone.
        </p>

        <div class="modal-buttons">
            <button
                class="secondary-button"
                onclick="closeModal()"
            >
                CANCEL
            </button>

            <button
                class="danger-button"
                onclick="confirmDeleteScene(${sceneId})"
            >
                DELETE
            </button>
        </div>
    `);
}

/**
 * Confirm and execute scene deletion
 * @param {number} sceneId - Database scene ID to delete
 */
async function confirmDeleteScene(sceneId) {
    // Close the confirmation modal
    closeModal();

    try {
        const response = await fetch(`/api/v2/scenes/${sceneId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (response.status === 401) {
            showToast('❌ Authentication required');
            return;
        }

        if (response.status === 404) {
            showToast('❌ Scene not found');
            return;
        }

        if (response.status === 403) {
            showToast('❌ Cannot delete system scenes');
            return;
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            showToast(`❌ ${errorData.error || 'Failed to delete scene'}`);
            return;
        }

        // Success - reload scenes and refresh UI
        await loadScenes();

        const content = document.getElementById('page-content');
        content.innerHTML = scenesHTML();

        bindDynamicButtons();

        showToast('✓ Scene deleted successfully');

    } catch (error) {
        console.error('Failed to delete scene:', error);
        showToast('❌ Network error. Please try again.');
    }
}


/* =====================================================
   SLEEP TIMER
===================================================== */

async function fetchSleepTimerStatus() {
    try {
        const response = await fetch('/api/v2/sleep-timer/status', {
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            if (data.timer && data.timer.active) {
                startSleepTimerDisplay(data.timer.endTime, data.timer.type);
            } else {
                stopSleepTimerDisplay();
            }
        }
    } catch (error) {
        console.error('Failed to fetch sleep timer status:', error);
    }
}

function startSleepTimerDisplay(endTime, timerType) {
    sleepTimerState.active = true;
    sleepTimerState.endTime = endTime;
    sleepTimerState.timerType = timerType || 'sleep_to_wake';

    // Clear existing interval
    if (sleepTimerState.updateInterval) {
        clearInterval(sleepTimerState.updateInterval);
    }

    // Update display immediately
    updateSleepTimerDisplay();

    // Update every second
    sleepTimerState.updateInterval = setInterval(updateSleepTimerDisplay, 1000);
}

function stopSleepTimerDisplay() {
    sleepTimerState.active = false;
    sleepTimerState.endTime = null;
    sleepTimerState.timerType = null;

    if (sleepTimerState.updateInterval) {
        clearInterval(sleepTimerState.updateInterval);
        sleepTimerState.updateInterval = null;
    }

    updateSleepTimerDisplay();
}

function updateSleepTimerDisplay() {
    const timerElement = document.getElementById('sleep-timer-display');
    if (!timerElement) return;

    if (!sleepTimerState.active || !sleepTimerState.endTime) {
        timerElement.style.display = 'none';
        return;
    }

    const now = Date.now();
    const remaining = sleepTimerState.endTime - now;

    if (remaining <= 0) {
        stopSleepTimerDisplay();
        return;
    }

    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const minutesStr = String(minutes).padStart(2, '0');
    const secondsStr = String(seconds).padStart(2, '0');

    // Determine display text based on timer type
    let timerLabel = 'SLEEP TIMER';
    let timerMessage = 'Wake Up will run automatically';
    let timerEmoji = '💤';

    if (sleepTimerState.timerType === 'wake_to_home') {
        timerLabel = 'HOME TIMER';
        timerMessage = 'Home will run automatically';
        timerEmoji = '🏠';
    }

    timerElement.innerHTML = `
        <div style="background: #0f1514; border: 1px solid #1c2525; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <div>
                    <div style="font-size: 11px; color: #8a9d9a; margin-bottom: 4px;">${timerLabel}</div>
                    <div style="font-size: 20px; font-weight: 600; color: #4ade80;">${minutesStr}:${secondsStr}</div>
                    <div style="font-size: 11px; color: #8a9d9a; margin-top: 2px;">${timerMessage}</div>
                </div>
                <div style="font-size: 24px;">${timerEmoji}</div>
            </div>
        </div>
    `;
    timerElement.style.display = 'block';
}


/* =====================================================
   MODAL
===================================================== */

function openModal(content) {

    document.getElementById(
        "modal-content"
    ).innerHTML = content;


    document
        .getElementById("modal")
        .classList.remove("hidden");

}


function closeModal() {

    document
        .getElementById("modal")
        .classList.add("hidden");

}


/* =====================================================
   LOG
===================================================== */

// PIR แจ้งซ้ำได้ไม่เกิน 1 ครั้ง/30 วินาทีต่อห้อง - firmware publish ทุก 2 วินาที
// ถ้ามีคนยืนหน้าเซนเซอร์ log จะเต็มด้วย Motion Detected กลบ event อื่นหมด
const MOTION_COOLDOWN_MS = 30000;
const lastMotionLog = {};

function shouldLogMotion(roomId) {
    const now = Date.now();
    if (lastMotionLog[roomId] && now - lastMotionLog[roomId] < MOTION_COOLDOWN_MS) {
        return false;
    }
    lastMotionLog[roomId] = now;
    return true;
}


/**
 * อัปเดตสถานะอุปกรณ์ในห้องจาก payload ของ home/status/{room}
 *
 * firmware publish ทุก 5 วินาทีไม่ว่าค่าจะเปลี่ยนหรือไม่ (STATUS_INTERVAL
 * ใน smart_home.ino) จึงต้องเทียบกับค่าเดิมก่อน แล้วเขียน log เฉพาะตอน
 * ค่าเปลี่ยนจริง ไม่งั้น live log จะเต็มด้วยข้อความซ้ำทุก 5 วินาที
 *
 * ครั้งแรกของแต่ละห้องถือเป็นการ sync สถานะจริงจากบอร์ด ไม่ใช่การเปลี่ยน
 * จึงไม่ขึ้น log (ค่าตั้งต้นใน rooms เป็นค่าสมมติ ไม่ได้มาจากฮาร์ดแวร์)
 */
function applyRoomStatus(room, payload) {

    if (!rooms[room]) return;

    const devices = rooms[room].devices;
    const firstSync = !syncedRooms[room];
    syncedRooms[room] = true;

    /** เขียนค่าใหม่ แล้ว log เฉพาะเมื่อเปลี่ยนจริงและไม่ใช่การ sync ครั้งแรก */
    const apply = (device, key, next, label, iconType) => {
        if (!device) return;
        const changed = device[key] !== next;
        device[key] = next;
        if (changed && !firstSync) {
            addLog(room, label(next), deviceIcon(iconType));
        }
    };

    if (payload.led !== undefined) {
        apply(devices.light, 'state', payload.led === true,
            v => `Light ${v ? 'ON' : 'OFF'}`, 'light');
    }

    if (payload.exhaustFan !== undefined || payload.fan !== undefined) {
        // living/kitchen ใช้ device key 'exhaust', bedroom ใช้ 'fan'
        const deviceKey = room === 'bedroom' ? 'fan' : 'exhaust';
        apply(devices[deviceKey], 'state',
            payload.exhaustFan === true || payload.fan === true,
            v => `Fan ${v ? 'ON' : 'OFF'}`, 'fan');
    }

    if (payload.ac !== undefined && devices.ac) {
        // ESP32 ส่ง duty cycle 0/70/90/100 แต่ UI ใช้ level 0-3
        let level = 0;
        if (payload.ac === 70) level = 1;
        else if (payload.ac === 90) level = 2;
        else if (payload.ac === 100) level = 3;

        apply(devices.ac, 'level', level,
            v => (v > 0 ? `AC ${acLevelLabel(v)}` : 'AC OFF'), 'ac');
        devices.ac.state = level > 0;
    }

    if (payload.window !== undefined) {
        apply(devices.window, 'state', payload.window > 90 ? 'open' : 'close',
            v => `Window ${v.toUpperCase()}`, 'servo');
    }
}


function addLog(roomId, text, icon) {

    const now =
        new Date()
            .toLocaleTimeString(
                [],
                {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit"
                }
            );


    logs.unshift({

        time: now,

        icon: icon,

        text: text,

        room:
            rooms[roomId]?.name
            || "System"

    });


    logs =
        logs.slice(0, 8);


    renderLogs();

}


/**
 * สร้าง HTML ของรายการ log - ใช้ทั้งตอน render หน้า dashboard ครั้งแรก
 * และตอน addLog() อัปเดตแบบ real-time
 */
function logItemsHTML() {

    if (logs.length === 0) {
        return `
            <div class="log-item">
                <strong>Waiting for events...</strong>
            </div>
        `;
    }

    return logs.map(log => `

            <div class="log-item">

                <time>
                    ${log.time}
                </time>

                <strong>
                    ${log.icon}
                    ${log.text}
                </strong>

                <small>
                    ${log.room}
                </small>

            </div>

        `).join("");

}


function renderLogs() {

    const container =
        document.getElementById(
            "dashboard-log-container"
        );


    if (!container)
        return;


    container.innerHTML = logItemsHTML();

}


/* =====================================================
   TOAST
===================================================== */

function showToast(message) {

    const toast =
        document.getElementById(
            "toast"
        );


    toast.textContent =
        message;


    toast.classList.add("show");


    setTimeout(() => {

        toast.classList.remove("show");

    }, 2500);

}


/* =====================================================
   SENSOR SIMULATION
===================================================== */

function startSensorSimulation() {

    setInterval(() => {

        const temperature =
            27.5 +
            Math.random() * 2;


        const humidity =
            60 +
            Math.random() * 8;


        document
            .querySelectorAll(
                "#temperature,#dashboard-temperature"
            )
            .forEach(element => {

                if (
                    element.id ===
                    "dashboard-temperature"
                ) {

                    element.innerHTML =
                        temperature.toFixed(1) +
                        "<small>°C</small>";

                } else {

                    element.textContent =
                        temperature.toFixed(1) +
                        "°C";

                }

            });


        document
            .querySelectorAll(
                "#humidity,#dashboard-humidity"
            )
            .forEach(element => {

                if (
                    element.id ===
                    "dashboard-humidity"
                ) {

                    element.innerHTML =
                        Math.round(humidity) +
                        "<small>%</small>";

                } else {

                    element.textContent =
                        Math.round(humidity) +
                        "%";

                }

            });


    }, 3000);

}


/* =====================================================
   CLOSE MODAL WHEN CLICK OUTSIDE
===================================================== */

document
    .getElementById("modal")
    .addEventListener("click", event => {

        if (
            event.target.id === "modal"
        ) {

            closeModal();

        }

    });

// ========================================
// Get Currently Playing Track
// ========================================

async function getCurrentlyPlaying() {

    const accessToken = localStorage.getItem(
        "spotify_access_token"
    );

    if (!accessToken) {
        console.log("Spotify ยังไม่ได้เชื่อมต่อ");
        return;
    }

    try {

        const response = await fetch(
            "https://api.spotify.com/v1/me/player/currently-playing",
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        // ไม่มีเพลงกำลังเล่น
        if (response.status === 204) {
            console.log("🎵 ตอนนี้ไม่มีเพลงกำลังเล่น");
            return;
        }

        // Token หมดอายุ
        if (response.status === 401) {
            console.log("Spotify Access Token หมดอายุ");
            return;
        }

        if (!response.ok) {
            console.error(
                "Currently Playing Error:",
                response.status
            );
            return;
        }

        const data = await response.json();

        currentTrack = {
            name: data.item?.name || "Unknown Track",
            artist: data.item?.artists?.map(a => a.name).join(", ") || "Unknown Artist",
            album: data.item?.album?.name || "Unknown Album",
            albumArt: data.item?.album?.images?.[0]?.url || null,
            duration: data.item?.duration_ms || 0,
            progress: data.progress_ms || 0
        };

        isPlaying = data.is_playing || false;

        console.log("🎵 Track updated:", currentTrack);

        // Start/stop progress update based on playing state
        if (isPlaying) {
            startProgressUpdate();
        } else {
            stopProgressUpdate();
        }

        // Update mini player
        updateMiniPlayer();

        return currentTrack;

    } catch (error) {

        console.error(
            "Spotify API Error:",
            error
        );

        return null;

    }
}

/* =====================================================
   MQTT CONNECTION & REAL-TIME UPDATES
===================================================== */

function setupMQTTConnection() {
    debugLog('[Frontend] Setting up MQTT connection...');

    // Connect to backend
    mqttClient.connect();

    // Handle connection events
    mqttClient.on('connected', () => {
        debugLog('[Frontend] Connected to MQTT Backend');
        systemStatus.mqtt = true;
        showToast('🟢 Connected to MQTT Server');
        updateSystemStatus();
    });

    mqttClient.on('disconnected', () => {
        debugLog('[Frontend] Disconnected from MQTT Backend');
        systemStatus.mqtt = false;
        systemStatus.esp32 = false;
        showToast('🔴 Disconnected from MQTT Server');
        updateSystemStatus();
    });

    // Handle initial state
    mqttClient.on('initial_state', (state, logs) => {
        // SECURITY: Don't log full state object
        debugLog('[Frontend] Received initial state:', state);

        // Update sensor data (รองรับทั้ง state.sensor และ state.sensors)
        if (state.sensors && state.sensors.dht22) {
            updateSensorData(state.sensors.dht22.temperature, state.sensors.dht22.humidity);
        } else if (state.sensor) {
            updateSensorData(state.sensor.temperature, state.sensor.humidity);
        }

        // Update system status
        if (state.system && state.system.status === 'online') {
            systemStatus.esp32 = true;
        }

        // Update device states
        updateDeviceStatesFromMQTT(state);

            // Only update system status badge
        updateSystemStatus();
    });

    // Live scene/mode sync across all connected clients (Scene Mode Phase 2)
    mqttClient.on('scene_changed', (scene) => {
        if (!scene) return;
        const next = scene.toLowerCase();
        if (activeScene !== next) {
            activeScene = next;
            renderPage();
        }
    });

    // Handle real-time messages
    mqttClient.on('message', (topic, payload) => {
        // Remove excessive console logging
        // console.log('[Frontend] MQTT Message:', topic, payload);

        // Update sensor data - DHT22 (รองรับทั้ง ESP32 format และ iot-dash format)
        if (topic === 'smarthome/sensor/dht22' || topic === 'home/sensor/dht22') {
            // รับ format: {"temperature": 28.5, "humidity": 65} หรือ {"temp": 28.5, "hum": 65}
            const temp = payload.temperature || payload.temp;
            const hum = payload.humidity || payload.hum;
            if (temp !== undefined && hum !== undefined) {
                sensorData.temperature = temp;
                sensorData.humidity = hum;
                updateSensorData(temp, hum);
            }
        }
        // รองรับ format แยก topic (backward compatibility)
        else if (topic === 'smarthome/sensor/dht22/temperature') {
            if (payload.temperature !== undefined) {
                sensorData.temperature = payload.temperature;
                updateSensorData(payload.temperature, sensorData.humidity || 0);
            }
        }
        else if (topic === 'smarthome/sensor/dht22/humidity') {
            if (payload.humidity !== undefined) {
                sensorData.humidity = payload.humidity;
                updateSensorData(sensorData.temperature || 0, payload.humidity);
            }
        }

        // Update mode (Manual / Automatic) - ต้องมาก่อน branch ที่เช็ค
        // topic.includes('/status/') เหมือน door ไม่งั้นจะถูกดักไปเข้า handler LED
        // บอร์ดเป็นคนบอกโหมดจริง (retained) จึงตรงแม้รีเฟรชหรือบอร์ดรีสตาร์ท
        else if (topic === 'home/status/mode') {
            if (payload.mode !== undefined) {
                const next = payload.mode === 'on';
                const changed = autoMode !== next;

                autoMode = next;
                renderModeToggle();

                // บอร์ด publish ทุก 5 วินาที - log เฉพาะตอนโหมดเปลี่ยนจริง
                if (changed) {
                    addLog(
                        null,
                        `Mode: ${autoMode ? 'AUTOMATION' : 'MANUAL'}`,
                        `<span class="material-symbols-outlined">${autoMode ? 'smart_toy' : 'pan_tool'}</span>`
                    );
                }
            }
        }

        // ค่า timeout จริงบนบอร์ด (ยืนยันแล้ว) - retained เหมือน home/status/mode
        // จึงได้ค่าถูกต้องทันทีตอนโหลด/reconnect ไม่ต้องรอ APPLY ก่อน
        else if (topic === 'home/status/auto/settings') {
            if (payload.lightFanTimeout !== undefined) autoSettings.lightFanTimeout = payload.lightFanTimeout;
            if (payload.acTimeout !== undefined) autoSettings.acTimeout = payload.acTimeout;
            refreshAutoSettingsCard();
        }

        // สถานะ PIR จริงแบบ real-time (retained) - แยกจาก home/sensor/pir/*
        // เดิมที่ยังทำงานเหมือนเดิมทุกอย่าง (log motion แบบ throttle 30s/ห้อง)
        else if (topic === 'home/status/pir') {
            if (payload.living !== undefined) pirStatus.living = !!payload.living;
            if (payload.kitchen !== undefined) pirStatus.kitchen = !!payload.kitchen;
            if (payload.bedroom !== undefined) pirStatus.bedroom = !!payload.bedroom;
            updatePIRStatusUI();
        }

        // Update Door status - ต้องมาก่อน branch ที่เช็ค topic.includes('/status/')
        // ไม่งั้น home/status/door จะถูกดักไปเข้า handler ของ LED แล้วหลุด
        else if (topic === 'home/status/door') {
            if (payload.locked !== undefined) {
                const wasLocked = doorState.locked;
                doorState.locked = payload.locked === true;

                // ถ้า ESP32 ล็อคเองระหว่างที่กำลังนับถอยหลัง ให้ยกเลิกตัวนับ
                if (doorState.locked && doorState.unlockTimer) {
                    clearInterval(doorState.unlockTimer);
                    doorState.unlockTimer = null;
                    doorState.unlockSecondsLeft = 0;
                }

                if (wasLocked !== doorState.locked) {
                    addLog(
                        null,
                        `Door ${doorState.locked ? 'LOCKED' : 'UNLOCKED'}`,
                        `<span class="material-symbols-outlined">${doorState.locked ? 'lock' : 'lock_open'}</span>`
                    );
                }

                refreshDoorCard();
            }
        }

        // Update LED status (รองรับทั้ง 2 format)
        else if (topic.startsWith('smarthome/device/led/') || topic.includes('/status/')) {
            let room;
            if (topic.startsWith('smarthome/device/led/')) {
                room = topic.split('/')[3];
            } else if (topic === 'home/status/living' || topic === 'home/status/kitchen' || topic === 'home/status/bedroom') {
                // ESP32 format: home/status/{room} with combined payload
                room = topic.split('/')[2];
                applyRoomStatus(room, payload);

                if (currentPage === 'rooms') {
                    renderPage();
                }
                return; // ออกจาก handler เพราะจัดการครบแล้ว
            }

            if (room && rooms[room] && rooms[room].devices.light) {
                const next = payload.state === 'on' || payload.state === true;
                const changed = rooms[room].devices.light.state !== next;
                rooms[room].devices.light.state = next;
                if (changed) {
                    addLog(room, `Light ${next ? 'ON' : 'OFF'}`, deviceIcon('light'));
                }
                if (currentPage === 'rooms') {
                    renderPage();
                }
            }
        }

        // Update Fan status
        else if (topic.startsWith('smarthome/fan/')) {
            const room = topic.split('/')[2];
            const deviceKey = room === 'bedroom' ? 'fan' : 'exhaust';
            if (rooms[room] && rooms[room].devices[deviceKey]) {
                const next = payload.state === 'on';
                const changed = rooms[room].devices[deviceKey].state !== next;
                rooms[room].devices[deviceKey].state = next;
                if (changed) {
                    addLog(room, `Fan ${next ? 'ON' : 'OFF'}`, deviceIcon('fan'));
                }
                // Only re-render if on rooms page
                if (currentPage === 'rooms') {
                    renderPage();
                }
            }
        }

        // Update AC status
        else if (topic.startsWith('smarthome/ac/')) {
            const room = topic.split('/')[2];
            if (rooms[room] && rooms[room].devices.ac) {
                const changed = rooms[room].devices.ac.level !== payload.level;
                rooms[room].devices.ac.level = payload.level;
                rooms[room].devices.ac.state = payload.level > 0;
                if (changed) {
                    addLog(room, payload.level > 0 ? `AC ${acLevelLabel(payload.level)}` : 'AC OFF', deviceIcon('ac'));
                }
                // Only re-render if on rooms page
                if (currentPage === 'rooms') {
                    renderPage();
                }
            }
        }

        // Update Servo status
        else if (topic.startsWith('smarthome/servo/')) {
            const device = topic.split('/')[2];
            Object.keys(rooms).forEach(roomKey => {
                if (rooms[roomKey].devices[device]) {
                    const changed = rooms[roomKey].devices[device].state !== payload.state;
                    rooms[roomKey].devices[device].state = payload.state;
                    if (changed) {
                        addLog(roomKey, `${device} ${payload.state}`, deviceIcon('servo'));
                    }
                }
            });
            // Only re-render if on rooms page
            if (currentPage === 'rooms') {
                renderPage();
            }
        }

        // Update Scene status
        else if (topic === 'smarthome/scene/status') {
            const next = payload.scene.toLowerCase();
            const changed = activeScene !== next;
            activeScene = next;
            if (changed) {
                addLog('living', `Scene: ${payload.scene}`, '<span class="material-symbols-outlined">theater_comedy</span>');
            }
            // Only re-render if on scenes page
            if (currentPage === 'scenes') {
                renderPage();
            }
        }

        // Update System status
        else if (topic === 'smarthome/system/status') {
            systemStatus.esp32 = payload.status === 'online';
            updateSystemStatus();
        }

        // Fingerprint events
        else if (topic === 'smarthome/fingerprint/status') {
            if (payload.success) {
                addLog('living', `Fingerprint: ${payload.message}`, '<span class="material-symbols-outlined">check_circle</span>');
                showToast(`✅ ${payload.message}`);
            } else {
                addLog('living', `Fingerprint Failed`, '<span class="material-symbols-outlined">cancel</span>');
                showToast('❌ Fingerprint Failed');
            }
        }

        // Update PIR Motion sensor (รองรับทั้ง 2 format)
        else if (topic.startsWith('smarthome/sensor/pir/') || topic.startsWith('home/sensor/pir/')) {
            let room;
            if (topic.startsWith('smarthome/sensor/pir/')) {
                room = topic.split('/')[3]; // smarthome/sensor/pir/living
            } else {
                room = topic.split('/')[3]; // home/sensor/pir/living
            }

            const motion = payload.motion || payload.pir === 1;

            // อัปเดต PIR status UI จาก topic นี้ด้วย เพราะ publish ทุก 2s
            // ต่อเนื่อง ไม่ต้องรอ home/status/pir ที่ publish เฉพาะตอนเปลี่ยนค่า/
            // reconnect เท่านั้น (อาจไม่มี retained messageใหม่พอ) - ไม่กระทบ
            // การทำงานเดิมของ topic นี้ (log motion throttle 30s) เลย
            if (room === 'living' || room === 'kitchen' || room === 'bedroom') {
                pirStatus[room] = !!motion;
                updatePIRStatusUI();
            }

            if (motion && shouldLogMotion(room)) {
                addLog(room, 'Motion Detected', '<span class="material-symbols-outlined">directions_walk</span>');
            }
        }
    });

    // ESP32 Automatic Mode debug telemetry - แยก event จาก 'message' เดิมทั้งหมด
    // (ฝั่ง backend ส่งเป็น WS type: 'debug_log' คนละ type กับ 'mqtt_message')
    mqttClient.on('debug_log', (data) => {
        debugLogs.unshift(data);
        if (debugLogs.length > MAX_DEBUG_LOGS) {
            debugLogs.length = MAX_DEBUG_LOGS;
        }
        renderDebugConsole();
    });

    // Fingerprint Admin Authorization Events
    mqttClient.on('fingerprint_admin_authorized', (data) => {
        debugLog('[Fingerprint Admin] Authorization granted:', data);
        window.adminAuthState.authorized = true;
        window.adminAuthState.pending = false;
        window.adminAuthState.user = data.user;
        window.adminAuthState.expiresAt = data.expiresAt;

        showToast('✅ Admin authorized: ' + data.user.name);

        if (currentPage === 'fingerprint') {
            renderPage();
            startAdminCountdown();
            loadFingerprintUsers();
        }
    });

    mqttClient.on('fingerprint_admin_denied', (data) => {
        console.log('[Fingerprint Admin] Authorization denied:', data);
        window.adminAuthState.pending = false;

        showToast('❌ Authorization denied: ' + data.reason);

        if (currentPage === 'fingerprint') {
            const msgEl = document.getElementById('admin-auth-message');
            if (msgEl) {
                msgEl.textContent = '❌ ' + data.reason;
            }
        }
    });

    mqttClient.on('fingerprint_admin_timeout', () => {
        console.log('[Fingerprint Admin] Authorization request timeout');
        window.adminAuthState.pending = false;

        showToast('⏱️ Authorization request timeout');

        if (currentPage === 'fingerprint') {
            const msgEl = document.getElementById('admin-auth-message');
            if (msgEl) {
                msgEl.textContent = '⏱️ Request timeout - please try again';
            }
        }
    });

    mqttClient.on('fingerprint_admin_expired', () => {
        console.log('[Fingerprint Admin] Session expired');
        window.adminAuthState.authorized = false;
        window.adminAuthState.user = null;
        window.adminAuthState.expiresAt = null;

        if (adminCountdownInterval) {
            clearInterval(adminCountdownInterval);
            adminCountdownInterval = null;
        }

        showToast('⏱️ Admin session expired');

        if (currentPage === 'fingerprint') {
            renderPage();
        }
    });

    mqttClient.on('fingerprint_admin_logout', () => {
        debugLog('[Fingerprint Admin] Logout');
        window.adminAuthState.authorized = false;
        window.adminAuthState.user = null;
        window.adminAuthState.expiresAt = null;

        if (adminCountdownInterval) {
            clearInterval(adminCountdownInterval);
            adminCountdownInterval = null;
        }

        if (currentPage === 'fingerprint') {
            renderPage();
        }
    });

    // Fingerprint Enrollment Events
    mqttClient.on('fingerprint_enrollment_started', (data) => {
        console.log('[Fingerprint Enrollment] Started:', data);
        showToast('🔵 Enrollment started for ' + data.name);
    });

    mqttClient.on('fingerprint_enrollment_progress', (data) => {
        console.log('[Fingerprint Enrollment] Progress:', data.status);

        if (currentPage === 'fingerprint') {
            handleEnrollmentProgress(data.status, data.error);
        }
    });

    mqttClient.on('fingerprint_enrollment_success', (data) => {
        console.log('[Fingerprint Enrollment] Success:', data);
        window.enrollmentState.active = false;

        showToast('✅ Fingerprint enrolled: ' + data.name);

        if (currentPage === 'fingerprint') {
            setTimeout(() => {
                renderPage();
                loadFingerprintUsers();
            }, 2000);
        }
    });

    mqttClient.on('fingerprint_enrollment_failed', (data) => {
        console.log('[Fingerprint Enrollment] Failed:', data.error);
        window.enrollmentState.active = false;

        showToast('❌ Enrollment failed: ' + data.error);

        if (currentPage === 'fingerprint') {
            setTimeout(() => {
                renderPage();
            }, 2000);
        }
    });

    mqttClient.on('fingerprint_enrollment_cancelled', () => {
        console.log('[Fingerprint Enrollment] Cancelled');
        window.enrollmentState.active = false;

        showToast('⚠️ Enrollment cancelled');

        if (currentPage === 'fingerprint') {
            setTimeout(() => {
                renderPage();
            }, 1000);
        }
    });

    mqttClient.on('fingerprint_enrollment_timeout', () => {
        console.log('[Fingerprint Enrollment] Timeout');
        window.enrollmentState.active = false;

        showToast('⏱️ Enrollment timeout');

        if (currentPage === 'fingerprint') {
            setTimeout(() => {
                renderPage();
            }, 1000);
        }
    });

    // Fingerprint Deletion Events
    mqttClient.on('fingerprint_deletion_started', (data) => {
        console.log('[Fingerprint Deletion] Started:', data);
        showToast('🔴 Deleting fingerprint: ' + data.name);
    });

    mqttClient.on('fingerprint_deletion_success', (data) => {
        console.log('[Fingerprint Deletion] Success:', data);
        showToast('✅ Fingerprint deleted: ' + data.name);

        if (currentPage === 'fingerprint') {
            loadFingerprintUsers();
        }
    });

    mqttClient.on('fingerprint_deletion_failed', (data) => {
        console.log('[Fingerprint Deletion] Failed:', data.error);
        showToast('❌ Deletion failed: ' + data.error);

        if (currentPage === 'fingerprint') {
            loadFingerprintUsers();
        }
    });

    mqttClient.on('fingerprint_deletion_timeout', (data) => {
        console.log('[Fingerprint Deletion] Timeout');
        showToast('⏱️ Deletion timeout - ESP32 did not respond');

        if (currentPage === 'fingerprint') {
            loadFingerprintUsers();
        }
    });
}

// จัดหมวดหมู่ debug log จาก tag นำหน้า message เช่น [AUTO PIR], [PIR], [AUTO TIMER]
function debugLogCategory(message) {
    if (!message) return 'other';
    if (message.includes('[PIR]') || message.includes('[AUTO PIR]')) return 'pir';
    if (message.includes('[AUTO TIMEOUT]')) return 'timeout';
    if (message.includes('[AUTO TIMER]')) return 'timer';
    if (message.includes('[AUTO SHUTDOWN]')) return 'shutdown';
    if (message.includes('[AUTO RESTORE]')) return 'restore';
    if (message.includes('[AUTO MODE]')) return 'mode';
    return 'other';
}

function renderDebugConsole() {
    const container = document.getElementById('debug-console-log');
    if (!container) return; // Settings page ไม่ได้เปิดอยู่ตอนนี้ - ข้ามไปเฉยๆ

    container.innerHTML = debugLogs.map(entry => {
        const category = debugLogCategory(entry.message);
        const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
        return `
            <div class="debug-log-entry debug-log-${category}">
                <span class="debug-log-time">${time}</span>
                <span class="debug-log-message">${entry.message}</span>
            </div>
        `;
    }).join('');

    // ใหม่สุดอยู่บน (unshift) - เลื่อน scroll ไปบนสุดเสมอ
    container.scrollTop = 0;
}

// Update sensor display
function updateSensorData(temperature, humidity) {
    // Store sensor data
    sensorData.temperature = temperature;
    sensorData.humidity = humidity;
    sensorData.lastUpdate = Date.now();

    debugLog('[Frontend] Updating sensor display:', temperature, humidity);

    // Update all temperature elements
    const tempElements = document.querySelectorAll('#temperature, #dashboard-temperature');
    tempElements.forEach(element => {
        const newValue = temperature.toFixed(1);

        if (element.id === 'dashboard-temperature') {
            // Update the sensor-value span inside
            const valueSpan = element.querySelector('.sensor-value');
            if (valueSpan) {
                valueSpan.textContent = newValue;
            } else {
                element.innerHTML = `<span class="sensor-value">${newValue}</span><small>°C</small>`;
            }
        } else {
            element.textContent = newValue + '°C';
        }
    });

    const humidityElements = document.querySelectorAll('#humidity, #dashboard-humidity');
    humidityElements.forEach(element => {
        const newValue = Math.round(humidity).toString();

        if (element.id === 'dashboard-humidity') {
            // Update the sensor-value span inside
            const valueSpan = element.querySelector('.sensor-value');
            if (valueSpan) {
                valueSpan.textContent = newValue;
            } else {
                element.innerHTML = `<span class="sensor-value">${newValue}</span><small>%</small>`;
            }
        } else {
            element.textContent = newValue + '%';
        }
    });

}

// Update device states from MQTT
function updateDeviceStatesFromMQTT(state) {
    if (state.led) {
        if (rooms.living.devices.light) rooms.living.devices.light.state = state.led.living;
        if (rooms.kitchen.devices.light) rooms.kitchen.devices.light.state = state.led.kitchen;
        if (rooms.bedroom.devices.light) rooms.bedroom.devices.light.state = state.led.bedroom;
    }

    if (state.fan) {
        if (rooms.living.devices.exhaust) rooms.living.devices.exhaust.state = state.fan.living;
        if (rooms.kitchen.devices.exhaust) rooms.kitchen.devices.exhaust.state = state.fan.kitchen;
        if (rooms.bedroom.devices.fan) rooms.bedroom.devices.fan.state = state.fan.bedroom;
    }

    if (state.ac) {
        if (rooms.living.devices.ac) {
            rooms.living.devices.ac.level = state.ac.living.level;
            rooms.living.devices.ac.state = state.ac.living.level > 0;
        }
        if (rooms.bedroom.devices.ac) {
            rooms.bedroom.devices.ac.level = state.ac.bedroom.level;
            rooms.bedroom.devices.ac.state = state.ac.bedroom.level > 0;
        }
    }

    if (state.servo) {
        if (rooms.kitchen.devices.window) rooms.kitchen.devices.window.state = state.servo.window;
        if (rooms.bedroom.devices.window) rooms.bedroom.devices.window.state = state.servo.window;
    }

    if (state.scene) {
        activeScene = state.scene.toLowerCase();
    }

    // backend ส่ง door มาเป็น 'locked' / 'unlocked' (projectState)
    if (state.door !== undefined) {
        doorState.locked = state.door !== 'unlocked';
        refreshDoorCard();
    }

    // โหมดควบคุมจาก backend - ผู้ใช้อาจสลับไว้จากอีกแท็บ/เครื่องอื่น
    if (state.system && state.system.autoMode !== undefined) {
        autoMode = state.system.autoMode === true;
        renderModeToggle();
    }

    if (state.system && state.system.autoSettings) {
        if (state.system.autoSettings.lightFanTimeout !== undefined) {
            autoSettings.lightFanTimeout = state.system.autoSettings.lightFanTimeout;
        }
        if (state.system.autoSettings.acTimeout !== undefined) {
            autoSettings.acTimeout = state.system.autoSettings.acTimeout;
        }
        refreshAutoSettingsCard();
    }

    // สถานะ PIR จริงแบบ real-time จาก home/status/pir (initial_state/reconnect)
    if (state.pir) {
        if (state.pir.living !== undefined) pirStatus.living = !!state.pir.living;
        if (state.pir.kitchen !== undefined) pirStatus.kitchen = !!state.pir.kitchen;
        if (state.pir.bedroom !== undefined) pirStatus.bedroom = !!state.pir.bedroom;
        updatePIRStatusUI();
    }
}

// Update system status display
function updateSystemStatus() {
    // Update header status badge
    const espStatus = document.querySelector('.esp-status');
    if (espStatus) {
        if (systemStatus.esp32) {
            espStatus.innerHTML = '<i class="online-dot"></i> ESP32 ONLINE';
            espStatus.style.color = '#4ee8ca';
        } else {
            espStatus.innerHTML = '<i class="offline-dot"></i> ESP32 OFFLINE';
            espStatus.style.color = '#ff6b6b';
        }
    }

    // Update system connections in dashboard (without full re-render)
    const connectionItems = document.querySelectorAll('.connection-item');
    connectionItems.forEach(item => {
        const span = item.querySelector('span');
        if (span && span.textContent === 'ESP32') {
            const small = item.querySelector('small');
            if (systemStatus.esp32) {
                item.className = 'connection-item connected';
                if (small) small.textContent = 'Connected';
            } else {
                item.className = 'connection-item disconnected';
                if (small) small.textContent = 'Offline';
            }
        }
        else if (span && span.textContent === 'MQTT') {
            const small = item.querySelector('small');
            if (systemStatus.mqtt) {
                item.className = 'connection-item connected';
                if (small) small.textContent = 'Connected';
            } else {
                item.className = 'connection-item disconnected';
                if (small) small.textContent = 'Offline';
            }
        }
        else if (span && span.textContent === 'MySQL') {
            const small = item.querySelector('small');
            if (systemStatus.mysql) {
                item.className = 'connection-item connected';
                if (small) small.textContent = 'Connected';
            } else {
                item.className = 'connection-item disconnected';
                if (small) small.textContent = 'Offline';
            }
        }
        else if (span && span.textContent === 'Telegram') {
            const small = item.querySelector('small');
            if (systemStatus.telegram) {
                item.className = 'connection-item connected';
                if (small) small.textContent = 'Ready';
            } else {
                item.className = 'connection-item disconnected';
                if (small) small.textContent = 'Offline';
            }
        }
    });
}

/* =====================================================
   DEMO DATA
===================================================== */
/* =====================================================
   FINGERPRINT MANAGEMENT - ADMIN AUTHORIZATION
===================================================== */

// Global state for admin authorization
window.adminAuthState = {
    authorized: false,
    pending: false,
    user: null,
    expiresAt: null
};

window.enrollmentState = {
    active: false,
    fingerprintId: null,
    name: null,
    role: null
};

let adminCountdownInterval = null;

async function requestAdminAuth() {
    try {
        const response = await fetch('/api/fingerprint/admin/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.success) {
            window.adminAuthState.pending = true;
            document.getElementById('admin-auth-message').textContent = '?? Please scan ADMIN fingerprint...';
            showToast('Please scan ADMIN fingerprint');
        } else {
            showToast('Failed to request authorization: ' + (data.message || 'Unknown error'));
        }
    } catch (err) {
        console.error('Error requesting admin auth:', err.message);
        showToast('Error: ' + err.message);
    }
}

async function logoutAdmin() {
    try {
        const response = await fetch('/api/fingerprint/admin/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.success) {
            window.adminAuthState.authorized = false;
            window.adminAuthState.user = null;
            window.adminAuthState.expiresAt = null;

            if (adminCountdownInterval) {
                clearInterval(adminCountdownInterval);
                adminCountdownInterval = null;
            }

            showToast('Admin session ended');
            renderPage();
        }
    } catch (err) {
        console.error('Error logging out admin:', err.message);
        showToast('Error: ' + err.message);
    }
}

function updateAdminCountdown() {
    if (!window.adminAuthState.authorized || !window.adminAuthState.expiresAt) {
        return;
    }

    const now = new Date();
    const expiresAt = new Date(window.adminAuthState.expiresAt);
    const remainingMs = expiresAt - now;

    if (remainingMs <= 0) {
        if (adminCountdownInterval) {
            clearInterval(adminCountdownInterval);
            adminCountdownInterval = null;
        }
        document.getElementById('admin-countdown').textContent = 'EXPIRED';
        return;
    }

    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);
    document.getElementById('admin-countdown').textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function startAdminCountdown() {
    if (adminCountdownInterval) {
        clearInterval(adminCountdownInterval);
    }

    updateAdminCountdown();
    adminCountdownInterval = setInterval(updateAdminCountdown, 1000);
}

/* =====================================================
   FINGERPRINT ENROLLMENT
===================================================== */

async function loadFingerprintUsers() {
    try {
        const response = await authenticatedFetch('/api/fingerprint/users');
        const data = await response.json();

        if (data.success) {
            // Suggest the lowest available fingerprint ID (1-10) for enrollment
            const existingIds = data.users.map(u => u.fingerprint_id);
            let suggestedId = null;
            for (let i = 1; i <= 10; i++) {
                if (!existingIds.includes(i)) {
                    suggestedId = i;
                    break;
                }
            }

            const enrollIdInput = document.getElementById('enroll-fp-id');
            if (enrollIdInput) {
                if (suggestedId !== null) {
                    enrollIdInput.value = suggestedId;
                } else {
                    console.warn('[Fingerprint] All IDs 1-10 are occupied - keeping current value');
                }
            }

            const listElement = document.getElementById('fingerprint-list');
            if (!listElement) return;

            if (data.users.length === 0) {
                listElement.innerHTML = '<p class="subtitle" style="padding: 20px; text-align: center;">No fingerprints registered</p>';
                return;
            }

            listElement.innerHTML = data.users.map(user => {
                // Fingerprint ID 1 is protected (Primary Administrator)
                const deleteButton = user.fingerprint_id === 1
                    ? '<span style="font-size: 0.85em; color: #999;">Protected</span>'
                    : `<button class="danger-button" style="padding: 4px 12px; font-size: 0.85em;" onclick="deleteFingerprint(${user.fingerprint_id})">Delete</button>`;

                return `
                    <div class="table-row" style="display: grid; grid-template-columns: 80px 1fr 100px 150px 100px; padding: 12px; border-bottom: 1px solid #e0e0e0; align-items: center;">
                        <span><strong>#${user.fingerprint_id}</strong></span>
                        <span>${user.name}</span>
                        <span class="${user.role === 'ADMIN' ? 'good' : ''}">${user.role}</span>
                        <span style="font-size: 0.9em; color: #666;">${new Date(user.created_at).toLocaleDateString()}</span>
                        <span>${deleteButton}</span>
                    </div>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('Error loading fingerprint users:', err.message);
    }
}

async function startEnrollment() {
    const fpId = parseInt(document.getElementById('enroll-fp-id').value);
    const name = document.getElementById('enroll-name').value.trim();
    const roleInput = document.getElementById('enroll-role');
    const role = roleInput ? roleInput.value : 'USER';

    console.log('Starting enrollment:', { fpId, name, role });

    if (!fpId || fpId < 1 || fpId > 10) {
        showToast('Invalid fingerprint ID (must be 1-10)');
        return;
    }

    if (!name || name.length < 2) {
        showToast('Name must be at least 2 characters');
        return;
    }

    try {
        const response = await fetch('/api/fingerprint/enroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprintId: fpId, name, role })
        });

        const data = await response.json();

        if (data.success) {
            window.enrollmentState.active = true;
            window.enrollmentState.fingerprintId = fpId;
            window.enrollmentState.name = name;
            window.enrollmentState.role = role;

            document.getElementById('enrollment-card').style.display = 'none';
            document.getElementById('enrollment-progress-card').style.display = 'block';
            document.getElementById('enrollment-message').textContent = 'Starting enrollment...';
            document.getElementById('enrollment-progress-bar').style.width = '0%';

            showToast('Enrollment started');
        } else {
            showToast('Failed to start enrollment: ' + (data.message || 'Unknown error'));
        }
    } catch (err) {
        console.error('Error starting enrollment:', err.message);
        showToast('Error: ' + err.message);
    }
}

async function cancelEnrollment() {
    try {
        const response = await fetch('/api/fingerprint/enroll/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.success) {
            showToast('Cancelling enrollment...');
        }
    } catch (err) {
        console.error('Error cancelling enrollment:', err.message);
        showToast('Error: ' + err.message);
    }
}

function handleEnrollmentProgress(status, error) {
    const messageEl = document.getElementById('enrollment-message');
    const progressBar = document.getElementById('enrollment-progress-bar');

    if (!messageEl || !progressBar) return;

    const progressSteps = {
        'started': { message: '?? Enrollment started', progress: 10 },
        'place_finger_1': { message: '?? Place your finger on the scanner', progress: 20 },
        'first_scan_success': { message: '?? First scan captured', progress: 40 },
        'remove_finger': { message: '? Remove your finger', progress: 50 },
        'place_finger_2': { message: '?? Place the SAME finger again', progress: 60 },
        'second_scan_success': { message: '?? Second scan captured', progress: 80 },
        'success': { message: '?? Enrollment complete!', progress: 100 },
        'failed': { message: '? Enrollment failed: ' + (error || 'Unknown error'), progress: 0 },
        'cancelled': { message: '?? Enrollment cancelled', progress: 0 }
    };

    const step = progressSteps[status];
    if (step) {
        messageEl.textContent = step.message;
        progressBar.style.width = step.progress + '%';
    }

    if (status === 'success' || status === 'failed' || status === 'cancelled') {
        setTimeout(() => {
            window.enrollmentState.active = false;
            renderPage();
            if (status === 'success') {
                loadFingerprintUsers();
            }
        }, 2000);
    }
}


/* =====================================================
   WEB USER MANAGEMENT (ADMIN ONLY)
===================================================== */

let userManagementState = {
    users: [],
    editingUserId: null
};

function usersHTML() {
    return `
        <div class="users-header">
            <div class="users-header-title">
                <h2>User Management</h2>
                <p>Manage web dashboard accounts</p>
            </div>
            <button class="btn-primary" onclick="openAddUserModal()">
                <span class="material-symbols-outlined">person_add</span>
                Add User
            </button>
        </div>

        <div class="user-table">
            <div class="user-table-header">
                <div>Name</div>
                <div>Username</div>
                <div>Email</div>
                <div>Role</div>
                <div>Status</div>
                <div>Last Login</div>
                <div>Actions</div>
            </div>
            <div id="user-table-body"></div>
        </div>
    `;
}

async function loadUsers() {
    try {
        const response = await authenticatedFetch('/api/users');
        const data = await response.json();
        if (data.success && data.users) {
            userManagementState.users = data.users;
            renderUserTable();
        } else {
            showToast('Failed to load users');
        }
    } catch (err) {
        console.error('[Users] Load failed:', err.message);
        showToast('Failed to load users');
    }
}

function renderUserTable() {
    const tbody = document.getElementById('user-table-body');
    if (!tbody) return;

    if (userManagementState.users.length === 0) {
        tbody.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No users found</div>';
        return;
    }

    tbody.innerHTML = userManagementState.users.map(user => {
        const lastLogin = user.last_login
            ? new Date(user.last_login).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'Never';
        const isActive = user.active === 1;
        const roleClass = user.role.toLowerCase();

        return `
            <div class="user-table-row">
                <div data-label="Name">${escapeHtml(user.full_name)}</div>
                <div data-label="Username">${escapeHtml(user.username)}</div>
                <div data-label="Email">${escapeHtml(user.email)}</div>
                <div data-label="Role">
                    <span class="user-role-badge ${roleClass}">${user.role}</span>
                </div>
                <div data-label="Status">
                    <span class="user-status ${isActive ? 'active' : 'disabled'}">
                        <span class="user-status-dot"></span>
                        ${isActive ? 'Active' : 'Disabled'}
                    </span>
                </div>
                <div data-label="Last Login">${lastLogin}</div>
                <div class="user-actions" data-label="Actions">
                    <button class="user-action-btn" onclick="openEditUserModal(${user.id})" title="Edit">
                        <span class="material-symbols-outlined">edit</span>
                    </button>
                    <button class="user-action-btn" onclick="toggleUserStatus(${user.id})" title="${isActive ? 'Disable' : 'Enable'}">
                        <span class="material-symbols-outlined">${isActive ? 'block' : 'check_circle'}</span>
                    </button>
                    <button class="user-action-btn danger" onclick="deleteUser(${user.id})" title="Delete">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function openAddUserModal() {
    userManagementState.editingUserId = null;
    document.getElementById('user-modal-title').textContent = 'Add User';
    document.getElementById('user-submit-btn').textContent = 'Create User';
    document.getElementById('user-password-field').style.display = 'block';
    document.getElementById('user-active-field').style.display = 'none';
    document.getElementById('user-modal-error').style.display = 'none';

    document.getElementById('user-form').reset();
    document.getElementById('user-role').value = 'USER';
    document.getElementById('user-password').setAttribute('required', 'required');

    document.getElementById('user-modal').classList.remove('hidden');
}

function openEditUserModal(userId) {
    const user = userManagementState.users.find(u => u.id === userId);
    if (!user) return;

    userManagementState.editingUserId = userId;
    document.getElementById('user-modal-title').textContent = 'Edit User';
    document.getElementById('user-submit-btn').textContent = 'Save Changes';
    document.getElementById('user-password-field').style.display = 'none';
    document.getElementById('user-active-field').style.display = 'block';
    document.getElementById('user-modal-error').style.display = 'none';

    document.getElementById('user-full-name').value = user.full_name;
    document.getElementById('user-username').value = user.username;
    document.getElementById('user-email').value = user.email;
    document.getElementById('user-role').value = user.role;
    document.getElementById('user-active').checked = user.active === 1;
    document.getElementById('user-password').removeAttribute('required');

    document.getElementById('user-modal').classList.remove('hidden');
}

function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
    document.getElementById('user-form').reset();
    userManagementState.editingUserId = null;
}

async function submitUserForm() {
    const fullName = document.getElementById('user-full-name').value.trim();
    const username = document.getElementById('user-username').value.trim();
    const email = document.getElementById('user-email').value.trim();
    const password = document.getElementById('user-password').value;
    const role = document.getElementById('user-role').value;
    const active = document.getElementById('user-active').checked ? 1 : 0;
    const errorDiv = document.getElementById('user-modal-error');

    if (!fullName || !username || !email || !role) {
        errorDiv.textContent = 'All fields are required';
        errorDiv.style.display = 'block';
        return;
    }

    if (username.length < 3) {
        errorDiv.textContent = 'Username must be at least 3 characters';
        errorDiv.style.display = 'block';
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorDiv.textContent = 'Invalid email address';
        errorDiv.style.display = 'block';
        return;
    }

    const isEditing = userManagementState.editingUserId !== null;

    if (!isEditing && password.length < 8) {
        errorDiv.textContent = 'Password must be at least 8 characters';
        errorDiv.style.display = 'block';
        return;
    }

    const submitBtn = document.getElementById('user-submit-btn');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
        const payload = { username, email, full_name: fullName, role };
        if (isEditing) {
            payload.active = active;
        } else {
            payload.password = password;
        }

        const url = isEditing ? `/api/users/${userManagementState.editingUserId}` : '/api/users';
        const method = isEditing ? 'PUT' : 'POST';

        const response = await authenticatedFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.success) {
            closeUserModal();
            showToast(data.message || (isEditing ? 'User updated successfully' : 'User created successfully'));
            await loadUsers();
        } else {
            errorDiv.textContent = data.message || 'Operation failed';
            errorDiv.style.display = 'block';
        }
    } catch (err) {
        console.error('[Users] Submit failed:', err.message);
        errorDiv.textContent = 'Failed to save user';
        errorDiv.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
}

async function toggleUserStatus(userId) {
    const user = userManagementState.users.find(u => u.id === userId);
    if (!user) return;

    const newActive = user.active === 1 ? 0 : 1;
    const action = newActive === 1 ? 'enable' : 'disable';

    if (!confirm(`Are you sure you want to ${action} this user?`)) return;

    try {
        const response = await authenticatedFetch(`/api/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                role: user.role,
                active: newActive
            })
        });

        const data = await response.json();
        if (data.success) {
            showToast(data.message || `User ${action}d successfully`);
            await loadUsers();
        } else {
            showToast(data.message || `Failed to ${action} user`);
        }
    } catch (err) {
        console.error('[Users] Toggle status failed:', err.message);
        showToast(`Failed to ${action} user`);
    }
}

async function deleteUser(userId) {
    const user = userManagementState.users.find(u => u.id === userId);
    if (!user) return;

    if (!confirm(`Are you sure you want to permanently delete the account "${user.username}"? This action cannot be undone.`)) {
        return;
    }

    try {
        const response = await authenticatedFetch(`/api/users/${userId}`, {
            method: 'DELETE'
        });

        const data = await response.json();
        if (data.success) {
            showToast(data.message || 'User deleted successfully');
            await loadUsers();
        } else {
            showToast(data.message || 'Failed to delete user');
        }
    } catch (err) {
        console.error('[Users] Delete failed:', err.message);
        showToast('Failed to delete user');
    }
}


/* =====================================================
   LOGOUT CONFIRMATION
===================================================== */

function openLogoutModal() {
    document.getElementById('logout-modal').classList.remove('hidden');
}

function closeLogoutModal() {
    document.getElementById('logout-modal').classList.add('hidden');
}

async function confirmLogout() {
    closeLogoutModal();
    await handleLogout();
}


/* =====================================================
   MOBILE NAVIGATION
===================================================== */

function setupMobileNavigation() {
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileCloseBtn = document.getElementById('mobileCloseBtn');
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('mobileSidebarBackdrop');
    const navItems = document.querySelectorAll('.nav-item');

    if (!mobileMenuBtn || !sidebar || !backdrop) {
        console.warn('[Mobile Nav] Elements not found');
        return;
    }

    // Open mobile menu
    function openMobileMenu() {
        sidebar.classList.add('mobile-open');
        backdrop.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    // Close mobile menu
    function closeMobileMenu() {
        sidebar.classList.remove('mobile-open');
        backdrop.classList.remove('active');
        document.body.style.overflow = '';
    }

    // Hamburger button click
    mobileMenuBtn.addEventListener('click', () => {
        if (sidebar.classList.contains('mobile-open')) {
            closeMobileMenu();
        } else {
            openMobileMenu();
        }
    });

    // Close button click
    if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', closeMobileMenu);
    }

    // Backdrop click
    backdrop.addEventListener('click', closeMobileMenu);

    // Close menu when navigation item is clicked
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // Close mobile menu on mobile screens
            if (window.innerWidth <= 768) {
                closeMobileMenu();
            }
        });
    });

    // Close menu on window resize if switching to desktop
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (window.innerWidth > 768 && sidebar.classList.contains('mobile-open')) {
                closeMobileMenu();
            }
        }, 250);
    });
}

// Initialize mobile navigation after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMobileNavigation);
} else {
    setupMobileNavigation();
}

/* =====================================================
   FLOATING DOCK MINIMIZE/COLLAPSE
===================================================== */

function setupFloatingDockControls() {
    const dockMenuBtn = document.querySelector('.dock-menu-btn');
    const dockExpandBtn = document.querySelector('.dock-expand-btn');
    const floatingDock = document.querySelector('.floating-dock');

    if (dockMenuBtn && floatingDock) {
        // Minimize button click
        dockMenuBtn.addEventListener('click', () => {
            floatingDock.classList.add('dock-minimized');
            dockMenuBtn.style.display = 'none';
            if (dockExpandBtn) {
                dockExpandBtn.style.display = 'flex';
            }
        });
    }

    if (dockExpandBtn && floatingDock) {
        // Expand button click
        dockExpandBtn.addEventListener('click', () => {
            floatingDock.classList.remove('dock-minimized');
            dockExpandBtn.style.display = 'none';
            if (dockMenuBtn) {
                dockMenuBtn.style.display = 'flex';
            }
        });
    }
}

// Initialize floating dock controls after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupFloatingDockControls);
} else {
    setupFloatingDockControls();
}

/* =====================================================
   SPOTIFY PLAYER MINIMIZE/RESTORE
===================================================== */

function minimizeSpotifyPlayer() {
    spotifyPlayerMinimized = true;
    renderPage();
    updateSpotifyMiniPlayer();
}

function restoreSpotifyPlayer(event) {
    // Only restore if clicking the container, not the play button
    if (event && event.target.closest('.spotify-mini-play-btn')) {
        return;
    }
    spotifyPlayerMinimized = false;
    renderPage();
    updateSpotifyMiniPlayer();
}

function updateSpotifyMiniPlayer() {
    const miniPlayer = document.getElementById('spotify-mini-player');
    if (!miniPlayer) return;

    // Show/hide based on state
    if (spotifyPlayerMinimized && spotifyLoggedIn && currentTrack) {
        miniPlayer.style.display = 'flex';

        // Update album art
        const miniAlbum = document.getElementById('mini-album');
        if (miniAlbum && currentTrack.albumArt) {
            miniAlbum.style.backgroundImage = `url('${currentTrack.albumArt}')`;
            miniAlbum.style.backgroundSize = 'cover';
            miniAlbum.style.backgroundPosition = 'center';
            miniAlbum.innerHTML = '';
        } else if (miniAlbum) {
            miniAlbum.style.backgroundImage = 'none';
            miniAlbum.innerHTML = '<span class="material-symbols-outlined">album</span>';
        }

        // Update track info
        const miniTrackName = document.getElementById('mini-track-name');
        const miniTrackArtist = document.getElementById('mini-track-artist');
        if (miniTrackName) miniTrackName.textContent = currentTrack.name;
        if (miniTrackArtist) miniTrackArtist.textContent = currentTrack.artist;

        // Update play/pause button
        const miniPlayBtn = document.getElementById('mini-play-btn');
        if (miniPlayBtn) {
            const icon = miniPlayBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = isPlaying ? 'pause' : 'play_arrow';
        }
    } else {
        miniPlayer.style.display = 'none';
    }
}

function setupSpotifyMiniPlayerListeners() {
    const miniPlayer = document.getElementById('spotify-mini-player');
    const miniPlayBtn = document.getElementById('mini-play-btn');

    if (miniPlayer) {
        miniPlayer.addEventListener('click', restoreSpotifyPlayer);
    }

    if (miniPlayBtn) {
        miniPlayBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            spotifyPlayPause();
        });
    }
}
