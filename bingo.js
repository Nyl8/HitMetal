/* =====================================================================
 * HITSTER METAL — bingo-modus
 *
 * Deelt Spotify-tokens met scan-modus (hm_* localStorage keys).
 * OAuth-callback gaat naar root index.html, dat tokens opslaat en
 * terugnavigeert naar deze pagina via hm_return_to.
 * Speelt nummer af via Spotify Web API op extern device (zelfde aanpak
 * als app.js). Auto-stop na 25 seconden.
 * ===================================================================== */

// ---------- DEBUG: zichtbare foutmeldingen ----------
function debugMsg(msg) {
  const el = document.getElementById("loading-msg");
  if (el) el.innerHTML = msg;
}
window.addEventListener("error", (e) => {
  debugMsg("⚠️ JS-fout:<br><small style='font-family:monospace;color:#ff6b6b'>"
    + (e.message || e.error || "onbekend") + "</small><br><small>"
    + (e.filename || "") + ":" + (e.lineno || "?") + "</small>");
});
window.addEventListener("unhandledrejection", (e) => {
  debugMsg("⚠️ Promise-fout:<br><small style='font-family:monospace;color:#ff6b6b'>"
    + (e.reason && e.reason.message ? e.reason.message : String(e.reason)) + "</small>");
});

// ---------- CONFIG ----------
const SPOTIFY_CLIENT_ID = "cb23c82938354534bc35099f6fde35f3";
const SCOPES = "user-modify-playback-state user-read-playback-state";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";

const REDIRECT_URI = (() => {
  let p = window.location.pathname;
  const i = p.lastIndexOf("/");
  if (i >= 0) p = p.substring(0, i + 1);
  return window.location.origin + p;
})();

const FRAGMENT_MS = 25000;
const THRESHOLD_YEAR = 1995;
const STORAGE_KEY = "hm_bingo_state_v3";

const LS = {
  token: "hm_access_token",
  refresh: "hm_refresh_token",
  expires: "hm_token_expires",
  verifier: "hm_code_verifier",
  returnTo: "hm_return_to",
  device: "hm_last_device",
};

// ---------- CATEGORIEEN ----------
const CATEGORIES = [
  { id: "decade",      label: "Decennium",       question: "Uit welk decennium komt dit nummer?", input: "decade" },
  { id: "year5",       label: "Jaar (±5)",       question: "In welk jaar is dit nummer uitgebracht? (±5 jaar mag)", input: "year" },
  { id: "country",     label: "Land",            question: "Uit welk land komt deze artiest?", input: "country" },
  { id: "artist",      label: "Artiest",         question: "Wie is de artiest?", input: "text" },
  { id: "beforeafter", label: "Voor of na " + THRESHOLD_YEAR, question: `Is dit nummer vóór of na ${THRESHOLD_YEAR} uitgebracht?`, input: "beforeafter" },
];
const COLOR_VAR = {
  decade: "var(--cat-decade)", year5: "var(--cat-year5)",
  country: "var(--cat-country)", artist: "var(--cat-artist)", beforeafter: "var(--cat-beforeafter)",
};

const COUNTRIES = {
  US:"Verenigde Staten", GB:"Verenigd Koninkrijk", SE:"Zweden", AU:"Australië",
  DE:"Duitsland", CH:"Zwitserland", NL:"Nederland", NO:"Noorwegen",
  IE:"Ierland", PT:"Portugal", BR:"Brazilië", FI:"Finland",
  FR:"Frankrijk", CA:"Canada", DK:"Denemarken",
};

// ---------- STATE ----------
let state = {
  phase: "loading",
  songs: null,
  players: [],
  turnIdx: 0,
  usedSongs: [],
  current: null,
  prevPhase: null,
};

let pauseTimer = null;

// ---------- UTILS ----------
function $(id) { return document.getElementById(id); }
function show(phase) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $("screen-" + phase).classList.add("active");
  state.phase = phase;
  saveState();
}
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function decadeOf(year) { return Math.floor(year / 10) * 10; }
function saveState() {
  try {
    const toSave = { ...state, songs: null }; // songs niet opslaan
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {}
}
function loadState() {
  try {
    // ruim oude versies op
    ["hm_bingo_state_v1", "hm_bingo_state_v2"].forEach(k => {
      try { localStorage.removeItem(k); } catch {}
    });
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) return JSON.parse(s);
  } catch {}
  return null;
}
function clearState() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }

// ---------- BINGOKAART ----------
function makeCard() {
  const colors = [];
  ["decade","year5","country","artist","beforeafter"].forEach(c => {
    for (let i = 0; i < 5; i++) colors.push(c);
  });
  const shuffled = shuffle(colors); // 25 cellen, geen free space
  return shuffled.map((color, idx) => ({ color, marked: false, idx }));
}

// ---------- SPOTIFY AUTH (zelfde patroon als app.js) ----------
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
  const data = await r.json();
  localStorage.setItem(LS.token, data.access_token);
  if (data.refresh_token) localStorage.setItem(LS.refresh, data.refresh_token);
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

// ---------- SPOTIFY PLAYBACK (extern device) ----------
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
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [trackUri], position_ms: positionMs }),
    }
  );
}

async function pausePlayback() {
  const token = await ensureValidToken();
  if (!token) return;
  try {
    await fetch("https://api.spotify.com/v1/me/player/pause", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {}
}

async function playCard(card) {
  const token = await ensureValidToken();
  if (!token) throw new Error("NEED_AUTH");

  const devices = await getDevices(token);
  if (devices.length === 0) throw new Error("NO_DEVICE");

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
    const r = await playOnDevice(token, d.id, trackUri, card.startMs || 0);
    if (r.status === 204) {
      localStorage.setItem(LS.device, d.id);
      // Auto-stop na FRAGMENT_MS
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(pausePlayback, FRAGMENT_MS);
      return;
    }
    lastErr = `status=${r.status}`;
  }
  throw new Error(`PLAY_FAILED ${lastErr || ""}`);
}

// ---------- VRAAGGENERATIE ----------
function pickSong() {
  const available = state.songs.filter(s => !state.usedSongs.includes(s.trackId));
  if (available.length === 0) {
    state.usedSongs = [];
    return rand(state.songs);
  }
  return rand(available);
}
function pickCategory() { return rand(CATEGORIES); }

// ---------- ANTWOORD-VALIDATIE ----------
function validateAnswer(input, category, song) {
  switch (category.id) {
    case "decade":  return parseInt(input, 10) === decadeOf(song.year);
    case "year5":   return Math.abs(parseInt(input, 10) - song.year) <= 5;
    case "country": return input === song.country;
    case "artist": {
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      return norm(input) === norm(song.artist);
    }
    case "beforeafter": {
      const isBefore = song.year < THRESHOLD_YEAR;
      return (input === "before" && isBefore) || (input === "after" && !isBefore);
    }
  }
}

// ---------- BINGO-DETECTIE ----------
function checkBingo(card) {
  const lines = [
    [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
    [0,6,12,18,24],[4,8,12,16,20],
  ];
  return lines.some(line => line.every(i => card[i].marked));
}

// ============================================================
// SCREEN HANDLERS
// ============================================================

async function bootstrap() {
  try {
    debugMsg("Stap 1/3: songs.json laden…");
    let songsData;
    try {
      const r = await fetch("songs.json");
      if (!r.ok) throw new Error("HTTP " + r.status);
      songsData = await r.json();
      state.songs = songsData.cards;
      if (!state.songs || state.songs.length === 0) throw new Error("songs.json leeg of geen cards-array");
    } catch (e) {
      debugMsg("⚠️ songs.json laden mislukt:<br><small>" + e.message + "</small>");
      return;
    }

    debugMsg("Stap 2/3: Spotify-token controleren…");
    const token = await ensureValidToken();
    if (!token) {
      debugMsg("Log in met Spotify om te beginnen.");
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.textContent = "Inloggen met Spotify";
      btn.onclick = () => startAuth(window.location.href);
      $("loading-buttons").appendChild(btn);
      return;
    }

    debugMsg("Stap 3/3: Spel klaarzetten…");
    // Geen auto-hervatten: elke keer terug naar setup. Eventuele oude
    // save-state wissen zodat hij nooit blijft hangen.
    clearState();
    state.players = [];
    state.turnIdx = 0;
    state.usedSongs = [];
    state.current = null;
    show("setup");
    renderPlayerList();
  } catch (e) {
    debugMsg("⚠️ Bootstrap-fout:<br><small style='font-family:monospace;color:#ff6b6b'>"
      + (e.message || String(e)) + "</small>");
  }
}

// ---------- SETUP ----------
function renderPlayerList() {
  const list = $("player-list");
  list.innerHTML = "";
  const inputs = state.players.length > 0 ? state.players : [{name:""},{name:""}];
  state.players = inputs;
  inputs.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `
      <input type="text" placeholder="Naam speler ${i+1}" value="${p.name||""}" data-idx="${i}">
      ${inputs.length > 2 ? `<button class="remove" data-rm="${i}">✕</button>` : ""}
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("input").forEach(inp => {
    inp.oninput = (e) => {
      const idx = +e.target.dataset.idx;
      state.players[idx].name = e.target.value.trim();
      $("start-game").disabled = state.players.filter(p => p.name).length < 2;
    };
  });
  list.querySelectorAll("[data-rm]").forEach(b => {
    b.onclick = (e) => {
      state.players.splice(+e.target.dataset.rm, 1);
      renderPlayerList();
    };
  });
  $("start-game").disabled = state.players.filter(p => p.name).length < 2;
}

$("add-player").onclick = () => {
  if (state.players.length < 8) {
    state.players.push({ name: "" });
    renderPlayerList();
  }
};

$("start-game").onclick = () => {
  state.players = state.players
    .filter(p => p.name)
    .map(p => ({ name: p.name, card: makeCard() }));
  state.turnIdx = 0;
  state.usedSongs = [];
  state.current = null;
  goToPass();
};

// ---------- PASS-THE-PHONE ----------
function goToPass() {
  $("pass-name").textContent = state.players[state.turnIdx].name;
  show("pass");
}
$("pass-ready").onclick = () => goToTurn();

// ---------- BEURT / SPINNER ----------
function goToTurn() {
  $("turn-name").textContent = state.players[state.turnIdx].name;
  $("spinner").className = "spinner-idle";
  $("spinner-result").classList.add("hidden");
  $("spinner-result").textContent = "";
  $("spin-btn").disabled = false;
  $("spin-btn").textContent = "Spin";
  show("turn");
}

$("show-card").onclick = () => {
  state.prevPhase = state.phase;
  $("card-name").textContent = state.players[state.turnIdx].name + "'s kaart";
  renderCardGrid("card-grid", state.players[state.turnIdx].card, null);
  show("card");
};
$("card-close").onclick = () => show(state.prevPhase || "turn");

$("stop-game").onclick = () => {
  if (!confirm("Spel stoppen? De voortgang gaat verloren.")) return;
  clearState();
  state = {
    phase: "loading", songs: state.songs, players: [], turnIdx: 0,
    usedSongs: [], current: null, prevPhase: null,
  };
  show("setup");
  renderPlayerList();
};

$("spin-btn").onclick = () => {
  $("spin-btn").disabled = true;
  const cat = pickCategory();
  const idx = CATEGORIES.findIndex(c => c.id === cat.id);
  const segment = 72; // 360/5
  const targetCenter = (idx * segment) + (segment / 2);
  const rotations = 3 * 360;
  const endRotation = rotations + (360 - targetCenter);
  $("spinner").style.setProperty("--end-rotation", endRotation + "deg");
  $("spinner").className = "spinner-spinning";

  setTimeout(() => {
    $("spinner-result").style.background = COLOR_VAR[cat.id];
    $("spinner-result").style.color = cat.id === "beforeafter" ? "#000" : "#fff";
    $("spinner-result").textContent = cat.label;
    $("spinner-result").classList.remove("hidden");
    state.current = { category: cat, song: pickSong() };
    saveState();
    setTimeout(() => goToPlay(), 1200);
  }, 2500);
};

// ---------- PLAY ----------
function goToPlay() {
  const { category } = state.current;
  $("play-category").textContent = category.label;
  $("play-category").style.background = COLOR_VAR[category.id];
  $("play-category").style.color = category.id === "beforeafter" ? "#000" : "#fff";
  $("play-question").textContent = category.question;
  $("play-btn").classList.remove("hidden");
  $("play-btn").disabled = false;
  $("replay-btn").classList.add("hidden");
  $("answer-btn").classList.add("hidden");
  $("play-status").textContent = "";
  show("play");
}

async function startPlayback() {
  const { song } = state.current;
  $("play-btn").disabled = true;
  $("play-status").textContent = "Afspelen…";
  try {
    await playCard(song);
    $("play-status").textContent = "▶ aan het spelen (25s)";
    $("replay-btn").classList.remove("hidden");
    $("answer-btn").classList.remove("hidden");
  } catch (e) {
    if (e.message === "NEED_AUTH") {
      await startAuth(window.location.href);
      return;
    }
    if (e.message === "NO_DEVICE") {
      $("play-status").textContent = "⚠️ Open Spotify even, speel iets, en kom terug.";
    } else {
      $("play-status").textContent = "Fout: " + e.message;
    }
    $("play-btn").disabled = false;
  }
}

$("play-btn").onclick = startPlayback;
$("replay-btn").onclick = () => { $("play-btn").disabled = false; startPlayback(); };
$("answer-btn").onclick = async () => {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  await pausePlayback();
  goToAnswer();
};

// ---------- ANTWOORD ----------
function goToAnswer() {
  const { category } = state.current;
  $("answer-category").textContent = category.label;
  $("answer-category").style.background = COLOR_VAR[category.id];
  $("answer-category").style.color = category.id === "beforeafter" ? "#000" : "#fff";
  $("answer-question").textContent = category.question;

  const area = $("answer-input-area");
  area.innerHTML = "";
  const submit = $("answer-submit");
  submit.classList.remove("hidden");

  switch (category.input) {
    case "year": {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = 1960; inp.max = new Date().getFullYear();
      inp.placeholder = "Bijv. 1986";
      inp.id = "answer-year";
      inp.inputMode = "numeric";
      area.appendChild(inp);
      setTimeout(() => inp.focus(), 100);
      break;
    }
    case "decade": {
      const sel = document.createElement("select");
      sel.id = "answer-decade";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Kies decennium…";
      placeholder.disabled = true;
      placeholder.selected = true;
      sel.appendChild(placeholder);
      ["1960","1970","1980","1990","2000","2010","2020"].forEach(d => {
        const o = document.createElement("option");
        o.value = d; o.textContent = d + "s";
        sel.appendChild(o);
      });
      area.appendChild(sel);
      break;
    }
    case "country": {
      const sel = document.createElement("select");
      sel.id = "answer-country";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Kies land…";
      placeholder.disabled = true;
      placeholder.selected = true;
      sel.appendChild(placeholder);
      const codes = Object.keys(COUNTRIES).sort((a,b) => COUNTRIES[a].localeCompare(COUNTRIES[b]));
      codes.forEach(c => {
        const o = document.createElement("option");
        o.value = c; o.textContent = COUNTRIES[c] + " (" + c + ")";
        sel.appendChild(o);
      });
      area.appendChild(sel);
      break;
    }
    case "text": {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "Naam artiest";
      inp.id = "answer-text";
      inp.autocomplete = "off";
      inp.autocapitalize = "words";
      area.appendChild(inp);
      setTimeout(() => inp.focus(), 100);
      break;
    }
    case "beforeafter": {
      submit.classList.add("hidden");
      const div = document.createElement("div");
      div.className = "bool-buttons";
      div.innerHTML = `
        <button class="yes" data-ans="before">VÓÓR ${THRESHOLD_YEAR}</button>
        <button class="no"  data-ans="after">NA ${THRESHOLD_YEAR}</button>
      `;
      area.appendChild(div);
      div.querySelectorAll("button").forEach(b => {
        b.onclick = () => submitAnswer(b.dataset.ans);
      });
      break;
    }
  }
  show("answer");
}

$("answer-submit").onclick = () => {
  const cat = state.current.category;
  let val = "";
  if (cat.input === "year")    val = $("answer-year").value;
  if (cat.input === "decade")  val = $("answer-decade").value;
  if (cat.input === "country") val = $("answer-country").value;
  if (cat.input === "text")    val = $("answer-text").value;
  if (!val) return; // niets ingevoerd of geen keuze gemaakt
  submitAnswer(val);
};

function submitAnswer(value) {
  const { category, song } = state.current;
  const correct = validateAnswer(value, category, song);
  state.current.answer = value;
  state.current.correct = correct;
  state.usedSongs.push(song.trackId);
  goToReveal();
}

// ---------- REVEAL ----------
function goToReveal() {
  const { category, song, correct } = state.current;
  const verdict = $("reveal-verdict");
  verdict.textContent = correct ? "✓ Goed!" : "✗ Helaas";
  verdict.className = "verdict " + (correct ? "correct" : "wrong");

  $("reveal-artist").textContent = song.artist;
  $("reveal-song").textContent = song.song;
  $("reveal-year").textContent = song.year;
  $("reveal-country").textContent = COUNTRIES[song.country] || song.country;

  const markArea = $("reveal-mark-area");
  const player = state.players[state.turnIdx];
  const hasMatchableCell = player.card.some(c => c.color === category.id && !c.marked);

  if (correct && hasMatchableCell) {
    markArea.classList.remove("hidden");
    renderCardGrid("reveal-card-grid", player.card, category.id);
    $("reveal-next").disabled = true;
  } else {
    markArea.classList.add("hidden");
    $("reveal-next").disabled = false;
  }
  show("reveal");
}

$("reveal-next").onclick = () => {
  const player = state.players[state.turnIdx];
  if (checkBingo(player.card)) {
    $("bingo-winner").textContent = player.name;
    show("bingo");
    return;
  }
  state.turnIdx = (state.turnIdx + 1) % state.players.length;
  state.current = null;
  goToPass();
};

// ---------- KAART RENDEREN ----------
function renderCardGrid(targetId, card, markableColor) {
  const grid = $(targetId);
  grid.innerHTML = "";
  card.forEach((cell, i) => {
    const div = document.createElement("div");
    div.className = "card-cell" + (cell.marked ? " marked" : "");
    div.dataset.color = cell.color;
    if (markableColor && cell.color === markableColor && !cell.marked) {
      div.classList.add("markable");
      div.onclick = () => {
        cell.marked = true;
        saveState();
        renderCardGrid(targetId, card, null);
        $("reveal-next").disabled = false;
      };
    }
    grid.appendChild(div);
  });
}

// ---------- BINGO RESTART ----------
$("bingo-restart").onclick = () => {
  clearState();
  state = {
    phase: "loading", songs: state.songs, players: [], turnIdx: 0,
    usedSongs: [], current: null, prevPhase: null,
  };
  show("setup");
  renderPlayerList();
};

// ---------- START ----------
bootstrap();
