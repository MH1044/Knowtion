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
  page: call('workspace:page'),
  createPage: call('workspace:create'),
  renamePage: call('workspace:rename'),
  movePage: call('workspace:move'),
  archivePage: call('workspace:archive'),
  restorePage: call('workspace:restore'),
  deletePage: call('workspace:delete'),
  search: call('workspace:search'),
  importNotion: call('import:notion'),
  keyStatus: call('keys:status'),
  beginKeySetup: call('keys:begin'),
  confirmKeySetup: call('keys:confirm'),
  grantKey: call('keys:grant'),
  revokeDevice: call('keys:revoke'),
  syncInfo: call('sync:info'),
  devices: call('sync:devices'),
  forgetDevice: call('sync:forget'),
  syncNow: call('sync:now'),
  chooseSyncFolder: call('sync:choose'),
  flush: call('workspace:flush'),
  openBody: call('body:open'),
  updateBody: call('body:update'),
  // The one channel that flows from main to renderer. The renderer gets the payload and
  // nothing else: the IpcRendererEvent carries the sender and any transferred ports.
  onChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('workspace:changed', listener);
    return () => ipcRenderer.removeListener('workspace:changed', listener);
  },
});
