// test/setup.js — installs a hand-rolled `chrome` global + browser polyfills.
// Runs once per test file (vitest setupFiles), before the file's imports.
import { vi, beforeEach } from 'vitest';

// In-memory chrome.storage area that behaves like the real get/set/remove.
function createStorageArea() {
  const store = {};
  return {
    _store: store,
    get: vi.fn(async (keys) => {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((k) => [k, store[k]]));
      }
      // object form: keys are defaults
      return Object.fromEntries(
        Object.keys(keys).map((k) => [k, k in store ? store[k] : keys[k]])
      );
    }),
    set: vi.fn(async (obj) => { Object.assign(store, obj); }),
    remove: vi.fn(async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    }),
    clear: vi.fn(async () => { for (const k of Object.keys(store)) delete store[k]; }),
  };
}

const chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    getURL: vi.fn((p) => `chrome-extension://test-ext-id/${p}`),
  },
  identity: {
    getRedirectURL: vi.fn((p = '') => `https://test-ext-id.chromiumapp.org/${p}`),
    // Default: behaves like a user cancelling (no redirect URL). Tests override.
    launchWebAuthFlow: vi.fn((_opts, cb) => cb(undefined)),
  },
  storage: {
    local: createStorageArea(),
    session: createStorageArea(),
  },
};

globalThis.chrome = chrome;

// jsdom does not implement innerText; alias it to textContent for scrape tests.
if (typeof globalThis.HTMLElement !== 'undefined' &&
    !Object.getOwnPropertyDescriptor(globalThis.HTMLElement.prototype, 'innerText')) {
  Object.defineProperty(globalThis.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
  });
}

// Reset mutable state before every test so cases don't bleed into each other.
beforeEach(() => {
  chrome.storage.local.clear();
  chrome.storage.session.clear();
  chrome.runtime.lastError = undefined;
  chrome.identity.launchWebAuthFlow.mockReset();
  chrome.identity.launchWebAuthFlow.mockImplementation((_opts, cb) => cb(undefined));
  globalThis.fetch = vi.fn();
});
