// liverics desktop — main process (the brain).
//
// Ingests now-playing data from multiple sources:
//   • YouTube Music — streamed in over a loopback WebSocket by the extension
//     (it brings its own pre-parsed lyrics).
//   • Spotify / Apple Music — polled locally via AppleScript; lyrics fetched
//     here from LRCLIB.
// Whichever source you most recently started playing owns the display
// (rising-edge takeover). Computes the current lyric line on a 100ms timer
// (in main, so it keeps running even when the overlay window is hidden) and
// pushes that single line to the floating overlay and/or the macOS menu bar.

const {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { fetchLyrics } = require("./lyrics");

const PORT = 8787;
const TICK_MS = 100;
const POLL_MS = 800; // AppleScript poll interval for Spotify / Apple Music
const STALE_MS = 4000; // if no fresh position in this long, treat as stopped
const DEFAULT_OFFSET_MS = 400;
const MAX_TITLE = 50;

// macOS players polled via AppleScript. `durMs`: Spotify reports duration in
// milliseconds, Apple Music in seconds. Position is seconds for both.
const PLAYERS = [
  { id: "spotify", app: "Spotify", durMs: true },
  { id: "applemusic", app: "Music", durMs: false },
];

let win = null;
let tray = null;
let mode = "overlay"; // "overlay" | "menubar" | "both" | "off"
let prevMode = "overlay";

// ---- render state (what pump() reads) ------------------------------------
let lines = [];
let kind = "synced"; // "synced" | "plain" | "empty"
let scale = 1;
let offsetMs = DEFAULT_OFFSET_MS;
let baseT = 0;
let baseClock = Date.now();
let paused = true;
let hasTrack = false;
let lastText = null;

// ---- multi-source model --------------------------------------------------
// reports[id] = { isPlaying, title, artist, duration, position, posClock, key }
const reports = {};
const lyricsCache = {}; // key -> { kind, lines, scale }
let activeSource = null;
let renderKey = null; // track key whose lyrics are loaded into render state
let loadToken = 0; // guards async lyric fetches against track changes

const keyFor = (id, title, artist) =>
  `${id}:${(title || "").toLowerCase()}|${(artist || "").toLowerCase()}`;

function report(id, r) {
  const prev = reports[id];
  reports[id] = r;

  const rising = r.isPlaying && !(prev && prev.isPlaying);
  if (rising) activeSource = id; // you just hit play here → it takes over
  if (!activeSource) activeSource = id; // first source ever

  // If the current owner isn't playing but another source is, hand off.
  const owner = reports[activeSource];
  if (!owner || !owner.isPlaying) {
    const playing = Object.keys(reports).find(
      (k) => reports[k] && reports[k].isPlaying
    );
    if (playing) activeSource = playing;
  }

  applyActive();
}

function applyActive() {
  const r = activeSource ? reports[activeSource] : null;
  if (!r || !r.title) {
    hasTrack = false;
    renderKey = null;
    lastText = null;
    pump();
    return;
  }
  baseT = r.position || 0;
  baseClock = r.posClock || Date.now();
  paused = !r.isPlaying;
  hasTrack = true;
  if (r.key !== renderKey) {
    renderKey = r.key;
    loadLyrics(activeSource, r);
  } else {
    pump();
  }
}

async function loadLyrics(id, r) {
  const token = ++loadToken;
  if (lyricsCache[r.key]) {
    applyLyrics(lyricsCache[r.key]);
    return;
  }
  // Clear while we resolve so a stale line doesn't linger.
  lines = [];
  kind = "empty";
  scale = 1;
  lastText = null;
  pump();

  // YouTube Music's lyrics arrive over the bus ('track' message) and are
  // cached by onBusMessage; nothing to fetch here.
  if (id === "ytmusic") return;

  let res;
  try {
    res = await fetchLyrics({
      title: r.title,
      artist: r.artist,
      duration: r.duration,
    });
  } catch (e) {
    res = { kind: "empty", lines: [], scale: 1 };
  }
  if (token !== loadToken || renderKey !== r.key) return; // superseded
  lyricsCache[r.key] = res;
  applyLyrics(res);
}

function applyLyrics(res) {
  lines = res.lines || [];
  kind = res.kind || "empty";
  scale = res.scale || 1;
  lastText = null;
  pump();
}

// ---- current line + displays ---------------------------------------------
function activeIndex(arr, t) {
  let lo = 0,
    hi = arr.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function currentLineText() {
  if (!hasTrack || paused) return "";
  if (Date.now() - baseClock > STALE_MS) return ""; // source vanished mid-song
  if (kind === "plain") return "♪ lyrics not synced";
  if (kind === "empty") return "";
  const playT = baseT + (Date.now() - baseClock) / 1000;
  const t = playT * scale + offsetMs / 1000;
  const i = activeIndex(lines, t);
  return i >= 0 ? lines[i].text : "";
}

const truncate = (s) =>
  s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1).trimEnd() + "…" : s;

function pushDisplays(text) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("liverics", { type: "line", text });
  }
  if (tray) {
    const inBar = mode === "menubar" || mode === "both";
    tray.setTitle(inBar && text ? " " + truncate(text) : " ♪");
  }
}

function pump() {
  const text = currentLineText();
  if (text !== lastText) {
    lastText = text;
    pushDisplays(text);
  }
}

// ---- YouTube Music (over the bus) ----------------------------------------
function onBusMessage(msg) {
  switch (msg.type) {
    case "track": {
      const r = reports.ytmusic || (reports.ytmusic = { isPlaying: false });
      r.title = msg.meta?.title || "";
      r.artist = msg.meta?.artist || "";
      r.key = keyFor("ytmusic", r.title, r.artist);
      lyricsCache[r.key] = {
        kind: msg.kind || "synced",
        lines: msg.lines || [],
        scale: msg.scale || 1,
      };
      if (activeSource === "ytmusic") applyActive();
      break;
    }
    case "pos": {
      const r = reports.ytmusic || (reports.ytmusic = {});
      r.position = msg.t;
      r.posClock = Date.now();
      r.isPlaying = !msg.paused;
      if (!r.key) r.key = keyFor("ytmusic", r.title, r.artist);
      report("ytmusic", r);
      break;
    }
    case "none":
      report("ytmusic", { isPlaying: false, title: "", artist: "", key: null });
      break;
  }
}

function startServer() {
  let wss;
  try {
    wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  } catch (e) {
    console.error("[liverics] could not start server:", e.message);
    return;
  }
  wss.on("connection", (sock) => {
    console.log("[liverics] sensor connected");
    sock.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      onBusMessage(msg);
    });
    // A closed socket (tab closed / browser quit / sleep) sends no 'none', so
    // clear the report ourselves — otherwise the overlay scrolls a dead song
    // and poisons arbitration.
    sock.on("close", () => {
      console.log("[liverics] sensor disconnected");
      report("ytmusic", { isPlaying: false, title: "", artist: "", key: null });
    });
  });
  wss.on("error", (e) => console.error("[liverics] WS server error:", e.message));
  wss.on("listening", () =>
    console.log(`[liverics] listening on ws://127.0.0.1:${PORT}`)
  );
}

// ---- Spotify / Apple Music (via AppleScript) -----------------------------
const inFlight = {};
const permDenied = {};

function scriptFor(appName) {
  // `is running` does NOT launch the app, so a player you don't use never
  // triggers an Automation prompt.
  return `
if application "${appName}" is running then
  tell application "${appName}"
    if player state is stopped then
      return "stopped"
    end if
    set t to current track
    return (player state as string) & tab & (name of t) & tab & (artist of t) & tab & ((duration of t) as string) & tab & (player position as string)
  end tell
else
  return "notrunning"
end if`;
}

function pollPlayer(p) {
  if (inFlight[p.id] || permDenied[p.id]) return;
  inFlight[p.id] = true;
  execFile(
    "osascript",
    ["-e", scriptFor(p.app)],
    { timeout: 2500 },
    (err, stdout, stderr) => {
      inFlight[p.id] = false;
      const notPlaying = { isPlaying: false, title: "", artist: "", key: null };

      if (err) {
        const m = `${stderr || ""} ${err.message || ""}`;
        if (/-1743|not authoriz|not allowed|not permitted/i.test(m)) {
          if (!permDenied[p.id]) {
            permDenied[p.id] = true;
            console.error(
              `[liverics] ${p.app}: Automation permission not granted. ` +
                `Allow it in System Settings → Privacy & Security → Automation, then restart liverics.`
            );
          }
        }
        report(p.id, notPlaying);
        return;
      }

      const out = (stdout || "").trim();
      if (!out || out === "notrunning" || out === "stopped") {
        report(p.id, notPlaying);
        return;
      }
      const parts = out.split("\t");
      if (parts.length < 5) {
        report(p.id, notPlaying);
        return;
      }
      const [state, title, artist, durStr, posStr] = parts;
      const duration = (parseFloat(durStr) || 0) / (p.durMs ? 1000 : 1);
      report(p.id, {
        isPlaying: state === "playing",
        title,
        artist,
        duration,
        position: parseFloat(posStr) || 0,
        posClock: Date.now(),
        key: keyFor(p.id, title, artist),
      });
    }
  );
}

function startPlayerPolling() {
  setInterval(() => {
    for (const p of PLAYERS) pollPlayer(p);
  }, POLL_MS);
}

// ---- window --------------------------------------------------------------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1100, workArea.width);
  const height = 200;

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "renderer", "overlay.html"));

  win.webContents.on("did-finish-load", () => {
    applyMode();
    lastText = null;
    pump();
  });
}

function applyMode() {
  if (win && !win.isDestroyed()) {
    const showWindow = mode === "overlay" || mode === "both";
    if (showWindow) win.showInactive();
    else win.hide();
  }
  pushDisplays(currentLineText());
  rebuildTrayMenu();
}

// ---- tray ----------------------------------------------------------------
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(" ♪");
  tray.setToolTip("liverics");
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const radio = (label, m) => ({
    label,
    type: "radio",
    checked: mode === m,
    click: () => {
      mode = m;
      applyMode();
    },
  });
  const menu = Menu.buildFromTemplate([
    { label: "liverics", enabled: false },
    { type: "separator" },
    radio("Overlay (on screen)", "overlay"),
    radio("Menu bar", "menubar"),
    radio("Both", "both"),
    radio("Off", "off"),
    { type: "separator" },
    {
      label: `Timing: ${offsetMs >= 0 ? "+" : ""}${offsetMs} ms lead`,
      enabled: false,
    },
    { label: "Earlier (−100 ms)", click: () => nudge(-100) },
    { label: "Later (+100 ms)", click: () => nudge(+100) },
    { label: "Reset timing", click: () => setOffset(DEFAULT_OFFSET_MS) },
    { type: "separator" },
    { label: "Quit liverics", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function nudge(d) {
  setOffset(offsetMs + d);
}
function setOffset(v) {
  offsetMs = v;
  lastText = null;
  pump();
  rebuildTrayMenu();
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Alt+Right", () => nudge(+100));
  globalShortcut.register("CommandOrControl+Alt+Left", () => nudge(-100));
  globalShortcut.register("CommandOrControl+Alt+0", () =>
    setOffset(DEFAULT_OFFSET_MS)
  );
  globalShortcut.register("CommandOrControl+Alt+H", () => {
    if (mode !== "off") {
      prevMode = mode;
      mode = "off";
    } else {
      mode = prevMode || "overlay";
    }
    applyMode();
  });
  globalShortcut.register("CommandOrControl+Alt+Q", () => app.quit());
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
  startServer();
  startPlayerPolling();
  registerShortcuts();
  setInterval(pump, TICK_MS);
});

app.on("window-all-closed", () => {});
app.on("will-quit", () => globalShortcut.unregisterAll());
