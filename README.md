# liverics

**Live lyrics, like subtitles, for the music you're already playing.**

liverics detects the song playing and shows its lyrics line-by-line, advancing
automatically in time with the music — karaoke-style subtitles for whatever's on.

## How it's built

The trick is to **split "what's playing" from "showing the lyrics."** The lyric
renderer is one reusable core; different "detectors" feed it the current song +
playback position.

| Mode | Source of truth | Sync quality |
|------|-----------------|--------------|
| **Linked** (built) | A browser extension reads YouTube Music's `<video>` position directly | Tight — millisecond-accurate |
| **Listen** (planned) | A microphone fingerprints whatever's playing (any device, any room) | Best-effort — follows along |

Lyrics come from **[LRCLIB](https://lrclib.net)** (free, synced `.lrc`, no key).
YouTube Music has no official "now playing" API, so Linked mode reads the page;
Listen mode (later) covers the phone / café / "music not on this computer" case.

## Roadmap

- **Slice 1 — Linked overlay (this repo, `extension/`).** Synced lyrics overlaid
  right on the YouTube Music page. No backend.
- **Slice 2 — Standalone display.** Lift the renderer into its own page + a thin
  sync channel, so lyrics can show on a *second* screen (TV / tablet).
- **Slice 3 — Listen mode.** Mic fingerprinting (AudD / ACRCloud) feeding the same
  renderer, for music playing on a phone or in the room.

## Install (slice 1)

It's an unpacked Chromium extension (Chrome / Edge / Brave / Arc):

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the `extension/` folder
4. Open <https://music.youtube.com> and play a song

The overlay appears near the bottom and follows along. Hit **×** to hide it
(reload the page to bring it back).

### Known rough edges

- **Title matching** is the hard part. YouTube titles are messy
  (`(Official Video)`, `feat.`, remixes); liverics normalizes the title and uses
  track **duration** to pick the right LRCLIB entry.
- **Different versions drift.** If the upload's length differs from the lyrics'
  source (slowed / sped-up / extended), liverics stretches the timeline to fit
  and shows a `⚠ version differs` note. Honest best-effort, not perfect.
- **No synced lyrics?** Falls back to plain (un-timed) text.
- **Chromium only** for now (Manifest V3). Firefox/Safari need small tweaks.
