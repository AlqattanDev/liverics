// liverics — background service worker
//
// Sole job: given a now-playing track, return the best synced-lyrics match
// from LRCLIB. The fetch lives here (not in the content script) so it isn't
// subject to YouTube Music's Content-Security-Policy and gets cross-origin
// access via the extension's host_permissions.

const LRCLIB = "https://lrclib.net/api";

// YouTube tacks a lot of noise onto titles — strip it so search can match the
// real song. "If u Fall (Official Video) [4K] feat. X" -> "If u Fall".
function normalizeTitle(raw) {
  if (!raw) return "";
  let t = raw;
  // Parenthetical / bracketed tags containing known noise words.
  t = t.replace(
    /[([][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|mv|explicit|remaster(?:ed)?|slowed|sped\s*up|reverb)\b[^)\]]*[)\]]/gi,
    ""
  );
  // feat. / ft. tails, with or without brackets.
  t = t.replace(/\s*[([]?\s*(?:feat\.?|ft\.?)\s+[^)\]]*[)\]]?/gi, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

// The player-bar byline is "Artist • Album • Year"; the artist is segment one.
function artistFromByline(byline) {
  if (!byline) return "";
  return byline.split("•")[0].trim();
}

function durDelta(result, duration) {
  if (!duration || !result.duration) return Number.MAX_SAFE_INTEGER;
  return Math.abs(result.duration - duration);
}

function shape(r, kind) {
  return {
    kind, // "synced" | "plain"
    id: r.id,
    trackName: r.trackName,
    artistName: r.artistName,
    albumName: r.albumName,
    lrcDuration: r.duration,
    syncedLyrics: r.syncedLyrics || null,
    plainLyrics: r.plainLyrics || null,
  };
}

async function lookupLyrics({ title, byline, duration }) {
  const track = normalizeTitle(title);
  const artist = artistFromByline(byline);
  if (!track) return null;

  const url =
    `${LRCLIB}/search` +
    `?track_name=${encodeURIComponent(track)}` +
    `&artist_name=${encodeURIComponent(artist)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`LRCLIB search ${res.status}`);
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  // Prefer entries with real timestamps; among those, pick the one whose
  // duration is closest to what's actually playing.
  const synced = results
    .filter((r) => r.syncedLyrics)
    .sort((a, b) => durDelta(a, duration) - durDelta(b, duration));
  if (synced.length) return shape(synced[0], "synced");

  // No synced lyrics anywhere — fall back to plain text so we can at least
  // show something (closest duration again).
  const plain = results
    .filter((r) => r.plainLyrics)
    .sort((a, b) => durDelta(a, duration) - durDelta(b, duration));
  return plain.length ? shape(plain[0], "plain") : null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "liverics:lookup") {
    lookupLyrics(msg.track)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response — keep the channel open
  }
});
