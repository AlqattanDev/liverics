// liverics — content script (runs on music.youtube.com)
//
// Two jobs:
//   1. SENSOR — read the now-playing track + position and stream it to the
//      liverics desktop app over a local WebSocket (the "universal" overlay
//      that floats over your whole screen).
//   2. FALLBACK — if the desktop app isn't running, render the lyrics as an
//      in-page overlay (slice 1 behaviour), so it still works on its own.

(() => {
  "use strict";

  const SELECTORS = {
    video: "video",
    title: ".title.ytmusic-player-bar",
    byline: ".byline.ytmusic-player-bar",
  };

  const TICK_MS = 150;
  const BUS_URL = "ws://127.0.0.1:8787"; // the desktop app's local server
  const POS_THROTTLE_MS = 180; // how often to stream position over the bus

  // Inlined so YouTube Music's CSP can't block it and there's no flash of
  // unstyled content. Scoped to the shadow root.
  const OVERLAY_CSS = `
:host { all: initial; }
.liverics {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
  z-index: 2147483647; box-sizing: border-box;
  width: min(900px, 92vw); max-height: 40vh; overflow: hidden;
  padding: 12px 22px 20px; border-radius: 16px;
  background: rgba(10,10,12,0.62);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  backdrop-filter: blur(16px) saturate(1.2);
  box-shadow: 0 10px 44px rgba(0,0,0,0.5); color: #fff;
  font-family: "YouTube Sans","Roboto",system-ui,-apple-system,sans-serif;
  user-select: none; pointer-events: auto;
}
.bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; opacity: 0.72; }
.brand { font-weight: 800; letter-spacing: 0.05em; color: #ff5da2; }
.status { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.hide { border: 0; background: none; color: #fff; font-size: 18px; line-height: 1; cursor: pointer; opacity: 0.6; }
.hide:hover { opacity: 1; }
.lines { text-align: center; line-height: 1.4; }
.prev, .next { min-height: 1.4em; font-size: 18px; font-weight: 500; opacity: 0.38; }
.cur { min-height: 1.4em; margin: 6px 0; font-size: 30px; font-weight: 700; white-space: pre-wrap; transition: opacity 0.12s ease; }
.liverics[data-state="plain"] .cur { font-size: 18px; font-weight: 500; max-height: 32vh; overflow-y: auto; text-align: left; }
.liverics[data-state="plain"] .prev, .liverics[data-state="plain"] .next { display: none; }
.liverics[data-state="empty"] .cur,
.liverics[data-state="idle"] .cur,
.liverics[data-state="loading"] .cur { opacity: 0.5; }
`;

  // ---- read the page -------------------------------------------------------

  function readNowPlaying() {
    const video = document.querySelector(SELECTORS.video);
    const title =
      document.querySelector(SELECTORS.title)?.textContent?.trim() || "";
    const byline =
      document.querySelector(SELECTORS.byline)?.textContent?.trim() || "";
    if (!video || !title) return null;
    return {
      title,
      byline,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      currentTime: video.currentTime,
      paused: video.paused,
    };
  }

  const keyOf = (np) => `${np.title} ${np.byline}`;
  const artistOf = (np) => (np.byline.split("•")[0] || "").trim();

  // ---- LRC parsing ---------------------------------------------------------

  function parseLRC(lrc) {
    const out = [];
    const stamp = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    for (const line of lrc.split("\n")) {
      const text = line.replace(stamp, "").trim();
      let m;
      stamp.lastIndex = 0;
      while ((m = stamp.exec(line)) !== null) {
        const time = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
        out.push({ time, text });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  function computeScale(lrcDuration, ytDuration) {
    if (!lrcDuration || !ytDuration) return 1;
    const s = lrcDuration / ytDuration;
    return s > 0.95 && s < 1.05 ? 1 : s;
  }

  function activeIndex(lines, t) {
    let lo = 0,
      hi = lines.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  // ---- in-page overlay (fallback when the desktop app isn't running) -------

  let host = null;
  let els = null;
  let timer = null;
  let userHidInPage = false;

  function buildOverlay() {
    host = document.createElement("div");
    host.id = "liverics-host";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);

    const root = document.createElement("div");
    root.className = "liverics";
    root.dataset.state = "loading";
    root.innerHTML = `
      <div class="bar">
        <span class="brand">liverics</span>
        <span class="status">starting…</span>
        <button class="hide" title="Hide (reload page to bring back)">×</button>
      </div>
      <div class="lines">
        <div class="prev"></div>
        <div class="cur"></div>
        <div class="next"></div>
      </div>`;
    shadow.appendChild(root);
    document.documentElement.appendChild(host);

    els = {
      root,
      status: root.querySelector(".status"),
      prev: root.querySelector(".prev"),
      cur: root.querySelector(".cur"),
      next: root.querySelector(".next"),
    };
    root.querySelector(".hide").addEventListener("click", () => {
      userHidInPage = true; // hide the in-page UI but keep sensing
      applyOverlayVisibility();
    });
  }

  const setStatus = (s) => els && (els.status.textContent = s);
  function setLines(prev, cur, next) {
    els.prev.textContent = prev || "";
    els.cur.textContent = cur || "";
    els.next.textContent = next || "";
  }

  // Hide the in-page overlay whenever the desktop app is driving the display.
  function applyOverlayVisibility() {
    if (host) host.style.display = busOpen || userHidInPage ? "none" : "";
  }

  // ---- track + lyrics state ------------------------------------------------

  let loadedKey = null;
  let inFlightKey = null;
  let lookupToken = 0;
  let lyrics = null; // [{time,text}] (time is null for plain)
  let kind = "synced";
  let scale = 1;
  let renderedIdx = -2;

  async function loadLyricsFor(np, key) {
    const myToken = ++lookupToken;
    inFlightKey = key;
    lyrics = null;
    renderedIdx = -2;
    els.root.dataset.state = "loading";
    setStatus("finding lyrics…");
    setLines("", "", "");

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "liverics:lookup",
        track: { title: np.title, byline: np.byline, duration: np.duration },
      });
    } catch (e) {
      if (myToken === lookupToken) {
        inFlightKey = null;
        els.root.dataset.state = "error";
        setStatus("lookup failed");
      }
      return;
    }
    if (myToken !== lookupToken) return; // a newer track superseded us

    inFlightKey = null;
    loadedKey = key;
    const meta = { title: np.title, artist: artistOf(np) };

    if (!resp || !resp.ok || !resp.data) {
      lyrics = null;
      kind = "empty";
      els.root.dataset.state = "empty";
      setStatus("no lyrics found 🤷");
      setLines("", "♪", "");
      publishTrack({ type: "track", meta, kind: "empty", scale: 1, lines: [] });
      return;
    }

    const d = resp.data;
    if (d.kind === "synced") {
      lyrics = parseLRC(d.syncedLyrics);
      kind = "synced";
      scale = computeScale(d.lrcDuration, np.duration);
      els.root.dataset.state = "ok";
      setStatus(
        scale === 1
          ? "synced"
          : `synced · ⚠ version differs (${Math.round(
              d.lrcDuration
            )}s vs ${Math.round(np.duration)}s) — approximating`
      );
      publishTrack({ type: "track", meta, kind: "synced", scale, lines: lyrics });
    } else {
      lyrics = (d.plainLyrics || "")
        .split("\n")
        .map((text) => ({ time: null, text }));
      kind = "plain";
      scale = 1;
      els.root.dataset.state = "plain";
      setStatus("plain lyrics (not time-synced)");
      setLines("", lyrics.map((l) => l.text).join("\n"), "");
      publishTrack({ type: "track", meta, kind: "plain", scale: 1, lines: lyrics });
    }
  }

  function renderSynced(np) {
    const t = np.currentTime * scale;
    const i = activeIndex(lyrics, t);
    if (i === renderedIdx) return;
    renderedIdx = i;
    if (i < 0) {
      setLines("", "♪", lyrics[0]?.text || "");
      return;
    }
    setLines(lyrics[i - 1]?.text, lyrics[i].text, lyrics[i + 1]?.text);
  }

  // ---- bus: stream to the desktop app --------------------------------------

  let bus = null;
  let busOpen = false;
  let busTimer = null;
  let lastTrackMsg = null; // replayed to the desktop app when it (re)connects
  let lastPosSent = 0;
  let sentNone = false;

  function busSend(msg) {
    if (busOpen && bus) {
      try {
        bus.send(JSON.stringify(msg));
      } catch (e) {
        /* socket closing; reconnect logic will handle it */
      }
    }
  }

  function publishTrack(msg) {
    lastTrackMsg = msg;
    busSend(msg);
  }

  function connectBus() {
    let sock;
    try {
      sock = new WebSocket(BUS_URL);
    } catch (e) {
      return scheduleReconnect();
    }
    bus = sock;
    sock.onopen = () => {
      busOpen = true;
      applyOverlayVisibility(); // desktop app is here → hide the in-page overlay
      if (lastTrackMsg) busSend(lastTrackMsg); // hand the current song over
    };
    sock.onclose = () => {
      busOpen = false;
      applyOverlayVisibility(); // desktop app gone → bring back in-page overlay
      scheduleReconnect();
    };
    sock.onerror = () => {
      /* onclose fires next and handles reconnect */
    };
  }

  function scheduleReconnect() {
    clearTimeout(busTimer);
    busTimer = setTimeout(connectBus, 3000);
  }

  function maybeSendPos(np) {
    const now = performance.now();
    if (now - lastPosSent < POS_THROTTLE_MS) return;
    lastPosSent = now;
    busSend({ type: "pos", t: np.currentTime, paused: np.paused });
  }

  // ---- main loop -----------------------------------------------------------

  function tick() {
    const np = readNowPlaying();
    if (!np) {
      els.root.dataset.state = "idle";
      setStatus("waiting for a song…");
      setLines("", "", "");
      if (!sentNone) {
        busSend({ type: "none" });
        sentNone = true;
      }
      // Note: don't clear loadedKey — a transient unreadable read mid-song
      // would otherwise force a needless re-fetch.
      return;
    }
    sentNone = false;

    const key = keyOf(np);
    if (key !== loadedKey && key !== inFlightKey) {
      loadLyricsFor(np, key);
      return;
    }
    if (key === loadedKey) {
      if (kind === "synced" && lyrics) renderSynced(np);
      maybeSendPos(np);
    }
  }

  buildOverlay();
  connectBus();
  timer = setInterval(tick, TICK_MS);
})();
