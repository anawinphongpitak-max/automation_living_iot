/* =====================================================
   SPOTIFY MODULE
   Handles Spotify authentication, playback control, and UI updates
===================================================== */

// Spotify state
let spotifyLoggedIn = false;
let spotifyAccessToken = null;
let currentTrack = null;
let isPlaying = false;
let progressInterval = null;

// Spotify Configuration
const SPOTIFY_CLIENT_ID = "8dc5441bc4b0418291af83403e02e71f";
const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:5500/";
const SPOTIFY_SCOPES = "user-read-currently-playing user-modify-playback-state user-read-playback-state";

/* =====================================================
   PKCE Authentication Helpers
===================================================== */

function generateRandomString(length) {
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const values = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(values).map(x => possible[x % possible.length]).join("");
}

async function sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return window.crypto.subtle.digest("SHA-256", data);
}

function base64encode(input) {
    return btoa(String.fromCharCode(...new Uint8Array(input)))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

/* =====================================================
   Spotify Authentication
===================================================== */

async function connectSpotify() {
    const codeVerifier = generateRandomString(64);
    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64encode(hashed);

    localStorage.setItem("spotify_code_verifier", codeVerifier);

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    const params = {
        response_type: "code",
        client_id: SPOTIFY_CLIENT_ID,
        scope: SPOTIFY_SCOPES,
        code_challenge_method: "S256",
        code_challenge: codeChallenge,
        redirect_uri: SPOTIFY_REDIRECT_URI
    };

    authUrl.search = new URLSearchParams(params).toString();
    window.location.href = authUrl.toString();
}

async function getSpotifyAccessToken(code) {
    const codeVerifier = localStorage.getItem("spotify_code_verifier");
    if (!codeVerifier) {
        console.error("ไม่พบ spotify_code_verifier");
        return null;
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: SPOTIFY_CLIENT_ID,
            grant_type: "authorization_code",
            code: code,
            redirect_uri: SPOTIFY_REDIRECT_URI,
            code_verifier: codeVerifier
        })
    });

    const data = await response.json();
    if (!response.ok) {
        console.error("Spotify Token Error:", data.error || 'Token request failed');
        return null;
    }

    localStorage.setItem("spotify_access_token", data.access_token);
    localStorage.setItem("spotify_refresh_token", data.refresh_token);
    localStorage.setItem("spotify_token_expires_at", Date.now() + data.expires_in * 1000);

    return data.access_token;
}

async function handleSpotifyCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (!code) return;

    // SECURITY: Don't log authorization code details
    debugLog("Spotify Authorization Code received!");
    const accessToken = await getSpotifyAccessToken(code);

    if (!accessToken) {
        console.error("ไม่สามารถรับ Access Token ได้");
        return;
    }

    spotifyLoggedIn = true;
    spotifyAccessToken = accessToken;

    window.history.replaceState({}, document.title, window.location.pathname);
    if (typeof renderPage === 'function') renderPage();
}

/* =====================================================
   Playback Control
===================================================== */

async function getCurrentlyPlaying() {
    const accessToken = localStorage.getItem("spotify_access_token");
    if (!accessToken) {
        console.log("Spotify ยังไม่ได้เชื่อมต่อ");
        return null;
    }

    try {
        const response = await fetch(
            "https://api.spotify.com/v1/me/player/currently-playing",
            { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (response.status === 204) {
            currentTrack = null;
            isPlaying = false;
            return null;
        }

        if (response.status === 401) {
            spotifyLogout();
            return null;
        }

        if (!response.ok) return null;

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
        return currentTrack;
    } catch (error) {
        console.error("Spotify API Error:", error);
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
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (response.status === 204 || response.status === 202) {
            isPlaying = !isPlaying;

            if (isPlaying) {
                startProgressUpdate();
            } else {
                stopProgressUpdate();
            }

            updateMiniPlayer();
            if (typeof currentPage !== 'undefined' && currentPage === 'dashboard' && typeof renderPage === 'function') {
                renderPage();
            }

            setTimeout(() => getCurrentlyPlaying(), 300);
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
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (response.status === 204 || response.status === 202) {
            stopProgressUpdate();
            setTimeout(async () => {
                await getCurrentlyPlaying();
                updateMiniPlayer();
                if (typeof currentPage !== 'undefined' && currentPage === 'dashboard' && typeof renderPage === 'function') {
                    renderPage();
                }
            }, 500);
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
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (response.status === 204 || response.status === 202) {
            stopProgressUpdate();
            setTimeout(async () => {
                await getCurrentlyPlaying();
                updateMiniPlayer();
                if (typeof currentPage !== 'undefined' && currentPage === 'dashboard' && typeof renderPage === 'function') {
                    renderPage();
                }
            }, 500);
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

    if (typeof renderPage === 'function') renderPage();
}

/* =====================================================
   Progress Updates
===================================================== */

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function startProgressUpdate() {
    if (progressInterval) clearInterval(progressInterval);

    progressInterval = setInterval(() => {
        if (isPlaying && currentTrack && currentTrack.progress < currentTrack.duration) {
            currentTrack.progress += 1000;

            const progressFill = document.querySelector('.progress-fill');
            const progressTime = document.querySelector('.media-progress small:first-child');

            if (progressFill && currentTrack.duration > 0) {
                const percentage = (currentTrack.progress / currentTrack.duration) * 100;
                progressFill.style.width = `${percentage}%`;
            }

            if (progressTime) {
                progressTime.textContent = formatTime(currentTrack.progress);
            }

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

/* =====================================================
   Mini Player Updates
===================================================== */

function updateMiniPlayer() {
    const miniPlayBtn = document.getElementById('mini-play-btn');
    const dockTrackName = document.getElementById('dock-track-name');
    const dockTrackArtist = document.getElementById('dock-track-artist');
    const dockAlbumArt = document.getElementById('dock-album-art');
    const miniProgress = document.getElementById('mini-progress');
    const progressCurrent = document.getElementById('progress-current');
    const progressDuration = document.getElementById('progress-duration');

    if (spotifyLoggedIn && currentTrack) {
        if (dockTrackName) dockTrackName.textContent = currentTrack.name;
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

        if (miniPlayBtn) {
            const icon = miniPlayBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = isPlaying ? 'pause' : 'play_arrow';
        }

        if (progressCurrent) progressCurrent.textContent = formatTime(currentTrack.progress);
        if (progressDuration) progressDuration.textContent = formatTime(currentTrack.duration);

        updateMiniProgress();
        if (miniProgress) miniProgress.style.display = 'block';

    } else if (spotifyLoggedIn && !currentTrack) {
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
}

function updateMiniProgress() {
    const miniProgressFill = document.querySelector('.mini-progress-fill');
    if (miniProgressFill && currentTrack && currentTrack.duration > 0) {
        const percentage = (currentTrack.progress / currentTrack.duration) * 100;
        miniProgressFill.style.width = `${Math.min(percentage, 100)}%`;
    }
}

/* =====================================================
   Initialization Check
===================================================== */

async function initializeSpotify() {
    await handleSpotifyCallback();

    const savedToken = localStorage.getItem("spotify_access_token");
    const expiresAt = localStorage.getItem("spotify_token_expires_at");

    if (savedToken && expiresAt && Date.now() < parseInt(expiresAt)) {
        spotifyLoggedIn = true;
        spotifyAccessToken = savedToken;
        await getCurrentlyPlaying();
    }
}
