// test/background.test.js — unit tests for the MV3 service worker logic:
// PKCE crypto, the OAuth authorization-code flow, the Salesforce REST layer,
// and the message router.
import { describe, it, expect, beforeEach } from 'vitest';
import { jsonResponse, textResponse } from './helpers.js';

import {
  base64UrlEncode,
  generateCodeVerifier,
  generateCodeChallenge,
  launchOAuth,
  exchangeCodeForToken,
  refreshAccessToken,
  sfRequest,
  upsertRecord,
} from '../linkedin-sf-ext/background.js';

// The message router registers its listener at import time via our mocked
// chrome.runtime.onMessage.addListener (a vi.fn that records the call).
const messageListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];

function dispatch(message) {
  return new Promise((resolve) => {
    const ret = messageListener(message, {}, resolve);
    expect(ret).toBe(true); // must keep the port open for the async response
  });
}

const noStatus = (body, status) => ({
  ok: status < 400, status, json: async () => body, text: async () => '',
});

describe('PKCE crypto', () => {
  it('base64UrlEncode is URL-safe and unpadded', () => {
    const out = base64UrlEncode(new Uint8Array([0xfb, 0xff]).buffer);
    expect(out).toBe('-_8');           // standard base64 "+/8=" → url-safe, no pad
    expect(out).not.toMatch(/[+/=]/);
  });

  it('generateCodeVerifier returns a 43-char URL-safe string, unique per call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('generateCodeChallenge matches the RFC 7636 test vector', async () => {
    const challenge = await generateCodeChallenge(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    );
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('launchOAuth', () => {
  it('refuses without a configured Client ID', async () => {
    const r = await launchOAuth();
    expect(r.error).toBe('NO_CLIENT_ID');
  });

  it('builds a PKCE authorization-code URL and completes the exchange', async () => {
    await chrome.storage.local.set({ sf_client_id: 'my-client' });
    chrome.identity.launchWebAuthFlow.mockImplementation((_o, cb) =>
      cb('https://test-ext-id.chromiumapp.org/salesforce?code=THECODE')
    );
    fetch.mockResolvedValueOnce(jsonResponse({
      access_token: 'AT', instance_url: 'https://org.my.salesforce.com',
      refresh_token: 'RT', token_type: 'Bearer',
    }));

    const r = await launchOAuth();
    expect(r).toEqual({ success: true });

    const url = chrome.identity.launchWebAuthFlow.mock.calls[0][0].url;
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('client_id=my-client');
    expect(url).toContain('code_challenge=');
    expect(url).not.toContain('response_type=token'); // no implicit flow
    expect(url).toContain(
      'redirect_uri=' + encodeURIComponent('https://test-ext-id.chromiumapp.org/salesforce')
    );

    const session = await chrome.storage.session.get(['sf_access_token', 'sf_refresh_token']);
    expect(session.sf_access_token).toBe('AT');
    expect(session.sf_refresh_token).toBe('RT');
  });

  it('reports AUTH_FAILED when the user cancels', async () => {
    await chrome.storage.local.set({ sf_client_id: 'my-client' });
    chrome.runtime.lastError = { message: 'User cancelled' };
    chrome.identity.launchWebAuthFlow.mockImplementation((_o, cb) => cb(undefined));
    const r = await launchOAuth();
    expect(r.error).toBe('AUTH_FAILED');
  });

  it('surfaces error_description from the redirect', async () => {
    await chrome.storage.local.set({ sf_client_id: 'my-client' });
    chrome.identity.launchWebAuthFlow.mockImplementation((_o, cb) =>
      cb('https://test-ext-id.chromiumapp.org/salesforce?error=access_denied&error_description=nope')
    );
    const r = await launchOAuth();
    expect(r).toEqual({ error: 'AUTH_FAILED', message: 'nope' });
  });

  it('reports NO_CODE when the redirect lacks a code', async () => {
    await chrome.storage.local.set({ sf_client_id: 'my-client' });
    chrome.identity.launchWebAuthFlow.mockImplementation((_o, cb) =>
      cb('https://test-ext-id.chromiumapp.org/salesforce?foo=bar')
    );
    const r = await launchOAuth();
    expect(r.error).toBe('NO_CODE');
  });
});

describe('exchangeCodeForToken', () => {
  it('POSTs the PKCE token request and stores the session', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({
      access_token: 'AT', instance_url: 'https://org', refresh_token: 'RT', token_type: 'Bearer',
    }));
    const r = await exchangeCodeForToken('cid', 'thecode', 'theverifier');
    expect(r).toEqual({ success: true });

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://login.salesforce.com/services/oauth2/token');
    const body = new URLSearchParams(opts.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('thecode');
    expect(body.get('code_verifier')).toBe('theverifier');
    expect(body.get('client_id')).toBe('cid');

    const s = await chrome.storage.session.get(['sf_access_token', 'sf_instance_url']);
    expect(s.sf_access_token).toBe('AT');
    expect(s.sf_instance_url).toBe('https://org');
  });

  it('returns TOKEN_EXCHANGE_FAILED with the SF error description', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(
      { error: 'invalid_grant', error_description: 'bad code' },
      { ok: false, status: 400 }
    ));
    const r = await exchangeCodeForToken('cid', 'x', 'y');
    expect(r).toEqual({ error: 'TOKEN_EXCHANGE_FAILED', message: 'bad code' });
  });
});

describe('refreshAccessToken', () => {
  it('returns NO_REFRESH_TOKEN when none is stored', async () => {
    await chrome.storage.local.set({ sf_client_id: 'cid' });
    const r = await refreshAccessToken();
    expect(r.error).toBe('NO_REFRESH_TOKEN');
  });

  it('refreshes and updates the stored access token', async () => {
    await chrome.storage.local.set({ sf_client_id: 'cid' });
    await chrome.storage.session.set({ sf_refresh_token: 'RT', sf_instance_url: 'https://org' });
    fetch.mockResolvedValueOnce(jsonResponse({ access_token: 'AT2', token_type: 'Bearer' }));

    const r = await refreshAccessToken();
    expect(r).toEqual({ success: true });
    const s = await chrome.storage.session.get(['sf_access_token']);
    expect(s.sf_access_token).toBe('AT2');

    const body = new URLSearchParams(fetch.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('RT');
  });

  it('returns REFRESH_FAILED on a bad response', async () => {
    await chrome.storage.local.set({ sf_client_id: 'cid' });
    await chrome.storage.session.set({ sf_refresh_token: 'RT' });
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { ok: false, status: 400 }));
    const r = await refreshAccessToken();
    expect(r.error).toBe('REFRESH_FAILED');
  });
});

describe('sfRequest', () => {
  beforeEach(async () => {
    await chrome.storage.session.set({
      sf_access_token: 'AT', sf_instance_url: 'https://org',
    });
  });

  it('returns NOT_AUTHENTICATED with no token', async () => {
    await chrome.storage.session.clear();
    expect(await sfRequest('GET', '/x')).toEqual({ error: 'NOT_AUTHENTICATED' });
  });

  it('builds the URL and bearer header and parses JSON', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const r = await sfRequest('GET', '/services/data/v59.0/query');
    expect(r).toEqual({ status: 200, data: { records: [] } });

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://org/services/data/v59.0/query');
    expect(opts.headers.Authorization).toBe('Bearer AT');
  });

  it('falls back to raw text when the body is not JSON', async () => {
    fetch.mockResolvedValueOnce(textResponse('plain text', { status: 200 }));
    const r = await sfRequest('GET', '/x');
    expect(r).toEqual({ status: 200, data: 'plain text' });
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    await chrome.storage.local.set({ sf_client_id: 'cid' });
    await chrome.storage.session.set({ sf_refresh_token: 'RT' });
    fetch
      .mockResolvedValueOnce(noStatus({}, 401))                                  // first call: expired
      .mockResolvedValueOnce(jsonResponse({ access_token: 'AT2', token_type: 'Bearer' })) // refresh
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }));                           // retry succeeds

    const r = await sfRequest('GET', '/x');
    expect(r).toEqual({ status: 200, data: { ok: 1 } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer AT2');
  });

  it('returns NOT_AUTHENTICATED when the refresh also fails', async () => {
    await chrome.storage.local.set({ sf_client_id: 'cid' });
    await chrome.storage.session.set({ sf_refresh_token: 'RT' });
    fetch
      .mockResolvedValueOnce(noStatus({}, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'x' }, { ok: false, status: 400 }));
    expect(await sfRequest('GET', '/x')).toEqual({ error: 'NOT_AUTHENTICATED' });
  });
});

describe('upsertRecord', () => {
  beforeEach(async () => {
    await chrome.storage.session.set({ sf_access_token: 'AT', sf_instance_url: 'https://org' });
  });

  it('updates (PATCH) when a record already exists', async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ records: [{ Id: '001' }] })) // soql lookup
      .mockResolvedValueOnce(noStatus({}, 204));                          // patch
    const r = await upsertRecord('Lead', { LastName: 'X' }, 'SELECT Id FROM Lead WHERE Email=\'a@b.com\'');
    expect(r).toEqual({ success: true, id: '001' });
    expect(fetch.mock.calls[1][1].method).toBe('PATCH');
    expect(fetch.mock.calls[1][0]).toBe('https://org/services/data/v59.0/sobjects/Lead/001');
  });

  it('creates (POST) when no record exists', async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse({ records: [] }))    // soql lookup
      .mockResolvedValueOnce(jsonResponse({ id: '002', success: true }, { status: 201 })); // create
    const r = await upsertRecord('Lead', { LastName: 'X' }, 'SELECT Id FROM Lead WHERE Email=\'a@b.com\'');
    expect(r).toEqual({ success: true, id: '002' });
    expect(fetch.mock.calls[1][1].method).toBe('POST');
  });
});

describe('message router', () => {
  it('responds to unknown actions with an error', async () => {
    expect(await dispatch({ action: 'nope' })).toEqual({ error: 'Unknown action: nope' });
  });

  it('round-trips setClientId / getClientId', async () => {
    expect(await dispatch({ action: 'setClientId', clientId: 'xyz' })).toEqual({ success: true });
    expect(chrome.storage.local._store.sf_client_id).toBe('xyz');
    expect(await dispatch({ action: 'getClientId' })).toEqual({ clientId: 'xyz' });
  });

  it('logout clears the session', async () => {
    await chrome.storage.session.set({ sf_access_token: 'AT', sf_refresh_token: 'RT' });
    expect(await dispatch({ action: 'logout' })).toEqual({ success: true });
    expect(chrome.storage.session._store.sf_access_token).toBeUndefined();
    expect(chrome.storage.session._store.sf_refresh_token).toBeUndefined();
  });

  // Documents a KNOWN VULNERABILITY: upsert SOQL is string-interpolated, so a
  // quote in the email breaks out of the literal. This test pins the current
  // (unsafe) behavior so a future escaping fix will intentionally flip it.
  it('upsertLead interpolates the email into SOQL unescaped (injection)', async () => {
    await chrome.storage.session.set({ sf_access_token: 'AT', sf_instance_url: 'https://org' });
    fetch
      .mockResolvedValueOnce(jsonResponse({ records: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: '00X' }, { status: 201 }));

    await dispatch({ action: 'upsertLead', fields: { Email: "a' OR Name!='", LastName: 'X' } });

    const queryUrl = decodeURIComponent(fetch.mock.calls[0][0]);
    expect(queryUrl).toContain("Email='a' OR Name!=''");
  });
});
