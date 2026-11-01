'use strict';
const {GeminiKeyStore, ModelKeyError, validGeminiKey} = require('./keyStore.cjs');

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';

/** Lists one model with the key in a header (never the URL) to prove Google accepts it. */
async function verifyGeminiKey(key, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(MODELS_URL, {headers: {'x-goog-api-key': key}, signal: AbortSignal.timeout(10000)}); }
  catch { throw new ModelKeyError('NETWORK', 'Could not reach Google. Check the network and try again.'); }
  if (response.ok) return;
  if ([400, 401, 403].includes(response.status)) throw new ModelKeyError('KEY_REJECTED', 'Google rejected this API key.');
  throw new ModelKeyError('UNAVAILABLE', `Google returned HTTP ${response.status}. Try again later.`);
}

class ModelController {
  constructor({store, getProvider, switchProvider, verify = verifyGeminiKey}) {
    Object.assign(this, {store, getProvider, switchProvider, verify});
    this.busy = false;
    this.switching = false;
  }
  async status() {
    if (this.switchError) throw new ModelKeyError('SWITCH_FAILED', this.switchError);
    return {provider: this.getProvider(), geminiConfigured: await this.store.has(),
      encryptionAvailable: this.store.encryptionAvailable()};
  }
  async exclusive(work) {
    if (this.busy || this.switching) throw new ModelKeyError('BUSY', 'Another model change is in progress.');
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  scheduleSwitch(provider, key) {
    this.switching = true;
    this.switchError = undefined;
    setImmediate(() => {
      void Promise.resolve().then(() => this.switchProvider(provider, key))
        .catch(() => { this.switchError = 'The model could not be switched. Restart the app and check model settings.'; })
        .finally(() => { this.switching = false; });
    });
  }
  saveGeminiKey(key) {
    return this.exclusive(async () => {
      if (!validGeminiKey(key)) throw new ModelKeyError('KEY_INVALID', 'This does not look like a Gemini API key.');
      await this.verify(key);
      await this.store.save(key);
      // Reply to the renderer first; switching reloads the page that is waiting for this answer.
      this.scheduleSwitch('gemini', key);
      return {restarting: true};
    });
  }
  clearGeminiKey() {
    return this.exclusive(async () => {
      await this.store.clear();
      const restarting = this.getProvider() === 'gemini';
      if (restarting) this.scheduleSwitch('codex', null);
      return {restarting};
    });
  }
}

function installModelHandlers(ipc, getWindow, controller, getOrigin) {
  const authorized = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === getOrigin(); } catch { return false; }
  };
  const operations = {
    getStatus: () => controller.status(),
    saveGeminiKey: key => controller.saveGeminiKey(key),
    clearGeminiKey: () => controller.clearGeminiKey(),
  };
  for (const [name, handler] of Object.entries(operations)) {
    ipc.handle(`model:${name}`, async (event, ...args) => {
      if (!authorized(event)) throw Error('Unauthorized model request.');
      try { return {ok: true, value: await handler(...args)}; }
      catch (error) {
        return {ok: false, error: {code: error.code || 'UNKNOWN',
          message: error instanceof ModelKeyError ? error.message : 'Model settings could not be updated.'}};
      }
    });
  }
  return () => { for (const name of Object.keys(operations)) ipc.removeHandler(`model:${name}`); };
}

module.exports = {GeminiKeyStore, ModelController, ModelKeyError, installModelHandlers, verifyGeminiKey, validGeminiKey};
