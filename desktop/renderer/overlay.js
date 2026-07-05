// liverics desktop — renderer (dumb display).
//
// All timing/sync lives in the main process now. This just shows whatever
// single line it's told to, and fades out when that line is empty.

const root = document.querySelector(".liverics");
const cur = document.querySelector(".cur");

window.liverics.onMessage((msg) => {
  if (msg.type === "line") {
    cur.textContent = msg.text || "";
    root.dataset.empty = msg.text ? "" : "1";
  }
});
