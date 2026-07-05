// Lyrics lookup for sources that don't bring their own lyrics (Spotify, Apple
// Music). Mirrors the extension's background.js logic, but in Node — so it
// runs in the Electron main process.

const LRCLIB = "https://lrclib.net/api";
// Node's fetch sends no User-Agent by default (the browser did, for free).
// LRCLIB asks for one and may reject blank-UA requests, so set it explicitly.
const UA = "liverics/0.1 (+https://github.com/liverics)";

function normalizeTitle(raw) {
  if (!raw) return "";
  let t = raw;
  t = t.replace(
    /[([][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|mv|explicit|remaster(?:ed)?|slowed|sped\s*up|reverb)\b[^)\]]*[)\]]/gi,
    ""
  );
  t = t.replace(/\s*[([]?\s*(?:feat\.?|ft\.?)\s+[^)\]]*[)\]]?/gi, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

function parseLRC(lrc) {
  const out = [];
  const stamp = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const line of lrc.split("\n")) {
    const text = line.replace(stamp, "").trim();
    let m;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(line)) !== null) {
      out.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function computeScale(lrcDuration, srcDuration) {
  if (!lrcDuration || !srcDuration) return 1;
  const s = lrcDuration / srcDuration;
  return s > 0.95 && s < 1.05 ? 1 : s;
}

function durDelta(r, d) {
  if (!d || !r.duration) return Number.MAX_SAFE_INTEGER;
  return Math.abs(r.duration - d);
}

// Returns { kind: "synced"|"plain"|"empty", lines: [{time,text}], scale }.
async function fetchLyrics({ title, artist, duration }) {
  const track = normalizeTitle(title);
  if (!track) return { kind: "empty", lines: [], scale: 1 };

  const url =
    `${LRCLIB}/search?track_name=${encodeURIComponent(track)}` +
    `&artist_name=${encodeURIComponent(artist || "")}`;

  let results;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
    results = await res.json();
  } catch (e) {
    return { kind: "empty", lines: [], scale: 1, error: String(e) };
  }
  if (!Array.isArray(results) || results.length === 0) {
    return { kind: "empty", lines: [], scale: 1 };
  }

  const synced = results
    .filter((r) => r.syncedLyrics)
    .sort((a, b) => durDelta(a, duration) - durDelta(b, duration));
  if (synced.length) {
    return {
      kind: "synced",
      lines: parseLRC(synced[0].syncedLyrics),
      scale: computeScale(synced[0].duration, duration),
    };
  }

  const plain = results
    .filter((r) => r.plainLyrics)
    .sort((a, b) => durDelta(a, duration) - durDelta(b, duration));
  if (plain.length) {
    return {
      kind: "plain",
      lines: plain[0].plainLyrics.split("\n").map((text) => ({ time: null, text })),
      scale: 1,
    };
  }

  return { kind: "empty", lines: [], scale: 1 };
}

module.exports = { fetchLyrics, parseLRC, computeScale, normalizeTitle };
