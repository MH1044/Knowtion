/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Written as CommonJS on purpose: a sandboxed preload cannot use ES modules, and
 * sandbox:true is what keeps a compromised renderer away from Node entirely.
 *
 * Every channel is listed explicitly. Exposing a generic invoke(channel, args) would
 * hand the renderer the whole IPC surface, which defeats the point of the bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('knowtion', {
  tree: call('workspace:tree'),
  trash: call('workspace:trash'),
  createPage: call('workspace:create'),
  renamePage: call('workspace:rename'),
  movePage: call('workspace:move'),
  archivePage: call('workspace:archive'),
  restorePage: call('workspace:restore'),
  deletePage: call('workspace:delete'),
  search: call('workspace:search'),
  flush: call('workspace:flush'),
  openBody: call('body:open'),
  updateBody: call('body:update'),
});
