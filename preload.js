const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  getState: () => ipcRenderer.invoke("app:state"),
  getVersions: () => ipcRenderer.invoke("app:versions"),
  addProfile: (name) => ipcRenderer.invoke("profile:add", name),
  selectProfile: (name) => ipcRenderer.invoke("profile:select", name),
  addFriend: (name) => ipcRenderer.invoke("friend:add", name),
  removeFriend: (name) => ipcRenderer.invoke("friend:remove", name),
  login: () => ipcRenderer.invoke("account:login"),
  logout: () => ipcRenderer.invoke("account:logout"),
  launch: (options) => ipcRenderer.invoke("game:launch", options),
  searchModrinth: (query, type) => ipcRenderer.invoke("modrinth:search", query, type),
  installModrinth: (id, type, version, loader) => ipcRenderer.invoke("modrinth:install", id, type, version, loader),
  installPvpPack: (version, loader) => ipcRenderer.invoke("modrinth:install-pvp-pack", version, loader),
  saveSkin: (dataUrl) => ipcRenderer.invoke("skin:save", dataUrl),
  uploadSkin: (variant) => ipcRenderer.invoke("skin:upload", variant),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("launcher:status", listener);
    return () => ipcRenderer.removeListener("launcher:status", listener);
  },
});
