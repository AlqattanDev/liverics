// Safe bridge: expose only a one-way message subscription to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liverics", {
  onMessage: (cb) => ipcRenderer.on("liverics", (_event, msg) => cb(msg)),
});
