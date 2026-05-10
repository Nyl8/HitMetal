/* =====================================================================
 * HITSTER METAL webapp
 *
 * Reads ?c=NNN from the URL, looks up the corresponding card in
 * songs.json, authenticates with Spotify (PKCE), and plays the track
 * at the pre-computed start position via the Spotify Web API.
 *
 * Setup: replace SPOTIFY_CLIENT_ID below with your own Client ID
 *        from https://developer.spotify.com/dashboard
 * ===================================================================== */

const SPOTIFY_CLIENT_ID = "cb23c82938354534bc35099f6fde35f3";

const SCOPES = "user-modify-playback-state user-read-playback-state";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";

// Use this page's URL as redirect URI. Add this exact URL (with trailing
// slash) to your Spotify dev app's Redirect URIs in the dashboard.
const REDIRECT_URI = (() => {
  const base = window.location.origin + window.location.pathname;
  return base.endsWith("/") ? base : base + "/";
})();

// localStorage keys
const LS = {
  token: "hm_access_token",
  refresh: "hm_refresh_token",
  expires: "hm_token_expires",
  verifier: "hm_code_verifier",
  returnTo: "hm_return_to",
  device: "hm_last_device",
};

/* -------- PKCE helpers -------------------------------------------------- */

function randomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  return Array.from(arr, b => charset[b % charset.length]).join("");
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

function base64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeChallenge(verifier) {
  return base64urlEncode(await sha256(verifier));
}

/* -------- Auth flow ----------------------------------------------------- */

async function startAuth(returnTo) {
  const verifier = randomString(64);
  const challenge = await makeChallenge(verifier);
  localStorage.setItem(LS.verifier, verifier);
  localStorage.setItem(LS.returnTo, returnTo);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
  });
  window.location.href = `${AUTHORIZE_URL}?${params}`;
}

async function exchangeCode(code) {
  const verifier = localStorage.getItem(LS.verifier);
  if (!verifier) throw new Error("Geen verifier in localStorage");

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: SPOTIFY_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Token exchange faalde: ${t}`);
  }
  storeTokens(await r.json());
  localStorage.removeItem(LS.verifier);
}

async function refreshAccessToken() {
  const rt = localStorage.getItem(LS.refresh);
  if (!rt) throw new Error("NO_REFRESH_TOKEN");

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: SPOTIFY_CLIENT_ID,
    }),
  });
  if (!r.ok) {
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.refresh);
    localStorage.removeItem(LS.expires);
    throw new Error("REFRESH_FAILED");
  }
  storeTokens(await r.json());
}

function storeTokens(data) {
  localStorage.setItem(LS.token, data.access_token);
  if (data.refresh_token) localStorage.setItem(LS.refresh, data.refresh_token);
  // expire 60s early to cover request latency
  localStorage.setItem(LS.expires, Date.now() + (data.expires_in - 60) * 1000);
}

async function ensureValidToken() {
  const expires = parseInt(localStorage.getItem(LS.expires) || "0", 10);
  if (!localStorage.getItem(LS.token)) return null;
  if (Date.now() < expires) return localStorage.getItem(LS.token);

  try {
    await refreshAccessToken();
    return localStorage.getItem(LS.token);
  } catch {
    return null;
  }
}

/* -------- Playback ------------------------------------------------------ */

async function getDevices(token) {
  const r = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Devices fetch failed: ${r.status}`);
  return (await r.json()).devices || [];
}

async function playOnDevice(token, deviceId, trackUri, positionMs) {
  return fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: [trackUri], position_ms: positionMs }),
    }
  );
}

async function playCard(card) {
  const token = await ensureValidToken();
  if (!token) throw new Error("NEED_AUTH");

  const devices = await getDevices(token);
  if (devices.length === 0) throw new Error("NO_DEVICE");

  // Try preferred order: last-used → active → first
  const lastId = localStorage.getItem(LS.device);
  const ordered = [];
  const byId = new Map(devices.map(d => [d.id, d]));
  if (lastId && byId.has(lastId)) ordered.push(byId.get(lastId));
  for (const d of devices) {
    if (d.is_active && !ordered.includes(d)) ordered.push(d);
  }
  for (const d of devices) {
    if (!ordered.includes(d)) ordered.push(d);
  }

  const trackUri = `spotify:track:${card.trackId}`;
  let lastErr = null;
  for (const d of ordered) {
    const r = await playOnDevice(token, d.id, trackUri, card.startMs);
    if (r.status === 204) {
      localStorage.setItem(LS.device, d.id);
      return;
    }
    lastErr = `status=${r.status}`;
    // 403 / 404 → try next device
  }
  throw new Error(`PLAY_FAILED ${lastErr || ""}`);
}

/* -------- UI helpers ---------------------------------------------------- */

const $status = () => document.getElementById("status");
const $actions = () => document.getElementById("actions");

function setStatus(msg, isError = false) {
  const el = $status();
  el.textContent = msg;
  el.className = isError ? "error" : "";
}

function clearActions() { $actions().innerHTML = ""; }

function addButton(label, fn) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.onclick = fn;
  $actions().appendChild(btn);
  return btn;
}

function addHint(text) {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  $actions().appendChild(p);
}

/* -------- QR scanner --------------------------------------------------- */

let scanner = null;

async function startScan() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div id="logo">⚡ HITSTER METAL ⚡</div>
    <div id="reader"></div>
    <div id="status">Richt op QR-code…</div>
    <div id="actions"></div>
  `;

  if (scanner) { try { await scanner.stop(); } catch (e) {} scanner = null; }

  scanner = new Html5Qrcode("reader", { verbose: false });

  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      onScanSuccess,
      () => {} // ignore per-frame "not found" errors
    );
  } catch (err) {
    setStatus("Camera kon niet starten", true);
    addHint(err.message || String(err));
    addButton("Terug", () => { location.href = REDIRECT_URI; });
    return;
  }

  async function onScanSuccess(decoded) {
    try { await scanner.stop(); } catch (e) {}
    scanner = null;

    let cardId = null;
    try {
      const url = new URL(decoded);
      cardId = url.searchParams.get("c");
    } catch (e) { /* not a URL */ }

    if (!cardId) {
      setStatus("Geen geldige Hitster Metal QR", true);
      addButton("Opnieuw scannen", startScan);
      return;
    }
    location.href = `?c=${cardId}`;
  }
}

/* -------- Main ---------------------------------------------------------- */

async function main() {
  if (SPOTIFY_CLIENT_ID === "PLACEHOLDER_CLIENT_ID") {
    setStatus("Setup nodig", true);
    addHint("Vul je Spotify Client ID in app.js (regel 13).");
    return;
  }

  const params = new URLSearchParams(window.location.search);

  // OAuth error response
  if (params.has("error")) {
    setStatus("Spotify-login afgewezen", true);
    addHint(params.get("error"));
    addButton("Opnieuw proberen", () => {
      window.location.href = REDIRECT_URI;
    });
    return;
  }

  // OAuth callback
  if (params.has("code")) {
    setStatus("Verbinden met Spotify…");
    try {
      await exchangeCode(params.get("code"));
      const ret = localStorage.getItem(LS.returnTo) || REDIRECT_URI;
      localStorage.removeItem(LS.returnTo);
      window.location.replace(ret);
    } catch (e) {
      setStatus("Verbinden faalde", true);
      addHint(e.message);
      addButton("Opnieuw", () => startAuth(REDIRECT_URI));
    }
    return;
  }

  const cardId = params.get("c");

  // No card → welcome screen
  if (!cardId) {
    if (localStorage.getItem(LS.token)) {
      setStatus("Klaar voor gebruik");
      addButton("📷 Scan kaart", startScan);
      addHint("Richt de camera op de QR-code van een kaart.");
    } else {
      setStatus("Eenmalig inloggen bij Spotify");
      addHint("Daarna onthoudt deze pagina je login.");
      addButton("Inloggen", () => startAuth(REDIRECT_URI));
    }
    return;
  }

  // Load song data
  let songsData;
  try {
    const r = await fetch("songs.json");
    if (!r.ok) throw new Error(`songs.json niet gevonden (status ${r.status})`);
    songsData = await r.json();
  } catch (e) {
    setStatus("Fout bij laden", true);
    addHint(e.message);
    return;
  }

  const card = songsData.cards.find(c => c.cardId === cardId);
  if (!card) {
    setStatus(`Kaart ${cardId} niet gevonden`, true);
    return;
  }

  // Optional ?s=NN override — start at NN seconds (handy for testing).
  const sOverride = params.get("s");
  if (sOverride !== null) {
    const sec = parseInt(sOverride, 10);
    if (!isNaN(sec) && sec >= 0) card.startMs = sec * 1000;
  }

  // Auth check
  const token = await ensureValidToken();
  if (!token) {
    setStatus("Eenmalig inloggen bij Spotify");
    addHint("Daarna onthoudt deze pagina je login.");
    addButton("Inloggen", () => startAuth(window.location.href));
    return;
  }

  // Play
  setStatus("Speelt af…");
  try {
    await playCard(card);
    setStatus("Speelt af");
    addHint("Leg je telefoon neer en raad het jaar.");
    addButton("📷 Scan volgende", startScan);
  } catch (e) {
    if (e.message === "NO_DEVICE") {
      setStatus("Geen actief Spotify-apparaat", true);
      addHint("Open Spotify, speel even iets, kom dan terug en probeer opnieuw.");
      addButton("Opnieuw proberen", () => location.reload());
    } else if (e.message === "NEED_AUTH") {
      await startAuth(window.location.href);
    } else {
      setStatus("Afspelen mislukt", true);
      addHint(e.message + " — heb je Spotify Premium?");
      addButton("Opnieuw", () => location.reload());
    }
  }
}

main();
