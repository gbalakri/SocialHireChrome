// background.js — MV3 Service Worker
// Handles Salesforce OAuth (Connected App / JWT flow) and REST API proxying.
// All sensitive credentials live only in chrome.storage.session (cleared on browser close).

const SF_LOGIN_URL   = 'https://login.salesforce.com';
const OAUTH_CALLBACK = chrome.identity.getRedirectURL('salesforce');

// ── OAuth ──────────────────────────────────────────────────────────────────

export async function getClientId() {
  const { sf_client_id } = await chrome.storage.local.get('sf_client_id');
  return sf_client_id || null;
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────
// Public clients (browser extensions) cannot keep a client secret, so we use the
// authorization-code flow with PKCE (RFC 7636). Salesforce's implicit/user-agent
// flow (response_type=token) is disabled by default on newer Connected Apps.

export function base64UrlEncode(buffer) {
  let str = '';
  for (const b of new Uint8Array(buffer)) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes.buffer); // 43-char URL-safe string
}

export async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export async function launchOAuth() {
  const clientId = await getClientId();
  if (!clientId) {
    return { error: 'NO_CLIENT_ID', message: 'Please set your Salesforce Connected App Client ID in extension options.' };
  }

  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authURL =
    `${SF_LOGIN_URL}/services/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}` +
    `&scope=${encodeURIComponent('api refresh_token')}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  const redirectUrl = await new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url: authURL, interactive: true },
      (url) => resolve(chrome.runtime.lastError ? null : url)
    );
  });

  if (!redirectUrl) {
    return { error: 'AUTH_FAILED', message: chrome.runtime.lastError?.message || 'Auth cancelled.' };
  }

  // The authorization code comes back in the query string.
  const returned = new URL(redirectUrl);
  const authError = returned.searchParams.get('error');
  if (authError) {
    return { error: 'AUTH_FAILED', message: returned.searchParams.get('error_description') || authError };
  }
  const code = returned.searchParams.get('code');
  if (!code) {
    return { error: 'NO_CODE', message: 'No authorization code returned.' };
  }

  return exchangeCodeForToken(clientId, code, codeVerifier);
}

export async function exchangeCodeForToken(clientId, code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     clientId,
    redirect_uri:  OAUTH_CALLBACK,
    code_verifier: codeVerifier,
  });

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    return { error: 'TOKEN_EXCHANGE_FAILED', message: data.error_description || data.error || 'Token exchange failed.' };
  }

  await chrome.storage.session.set({
    sf_access_token:  data.access_token,
    sf_instance_url:  data.instance_url || '',
    sf_token_type:    data.token_type,
    sf_refresh_token: data.refresh_token || null,
  });
  return { success: true };
}

export async function refreshAccessToken() {
  const clientId = await getClientId();
  const { sf_refresh_token, sf_instance_url } = await chrome.storage.session.get(['sf_refresh_token', 'sf_instance_url']);
  if (!clientId || !sf_refresh_token) return { error: 'NO_REFRESH_TOKEN' };

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: sf_refresh_token,
    client_id:     clientId,
  });

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) return { error: 'REFRESH_FAILED' };

  await chrome.storage.session.set({
    sf_access_token: data.access_token,
    sf_instance_url: data.instance_url || sf_instance_url || '',
    sf_token_type:   data.token_type,
  });
  return { success: true };
}

export async function getSession() {
  return chrome.storage.session.get(['sf_access_token', 'sf_instance_url']);
}

export async function logout() {
  await chrome.storage.session.remove(['sf_access_token', 'sf_instance_url', 'sf_token_type', 'sf_refresh_token']);
  return { success: true };
}

// ── Salesforce REST API ────────────────────────────────────────────────────

export async function sfRequest(method, path, body, retried = false) {
  const { sf_access_token, sf_instance_url } = await getSession();
  if (!sf_access_token) return { error: 'NOT_AUTHENTICATED' };

  const url = `${sf_instance_url}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${sf_access_token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  // Access token expired — refresh once and retry transparently.
  if (res.status === 401 && !retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed.success) return sfRequest(method, path, body, true);
    return { error: 'NOT_AUTHENTICATED' };
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

export async function soqlQuery(query) {
  const path = `/services/data/v59.0/query?q=${encodeURIComponent(query)}`;
  return sfRequest('GET', path);
}

export async function createRecord(objectType, fields) {
  const path = `/services/data/v59.0/sobjects/${objectType}/`;
  const result = await sfRequest('POST', path, fields);
  if (result.data?.id) return { success: true, id: result.data.id };
  return { error: result.data?.[0]?.message || 'Create failed', raw: result };
}

export async function updateRecord(objectType, id, fields) {
  const path = `/services/data/v59.0/sobjects/${objectType}/${id}`;
  const result = await sfRequest('PATCH', path, fields);
  if (result.status === 204) return { success: true, id };
  return { error: result.data?.[0]?.message || 'Update failed', raw: result };
}

export async function upsertRecord(objectType, fields, uniqueQuery) {
  // Check for existing record first
  const existing = await soqlQuery(uniqueQuery);
  if (existing.error) return existing;

  const records = existing.data?.records;
  if (records && records.length > 0) {
    // Update
    return updateRecord(objectType, records[0].Id, fields);
  }
  // Create
  return createRecord(objectType, fields);
}

export async function getAccounts() {
  const result = await soqlQuery("SELECT Id, Name FROM Account ORDER BY Name LIMIT 200");
  if (result.error || !result.data?.records) return { error: 'Could not fetch accounts', records: [] };
  return { records: result.data.records };
}

// ── Message Router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case 'authorize':
        sendResponse(await launchOAuth());
        break;
      case 'logout':
        sendResponse(await logout());
        break;
      case 'getSession':
        sendResponse(await getSession());
        break;
      case 'getAccounts':
        sendResponse(await getAccounts());
        break;
      case 'upsertLead':
        sendResponse(await upsertRecord('Lead', msg.fields,
          `SELECT Id FROM Lead WHERE Email='${msg.fields.Email}'`));
        break;
      case 'upsertContact':
        sendResponse(await upsertRecord('Contact', msg.fields,
          `SELECT Id FROM Contact WHERE Email='${msg.fields.Email}'`));
        break;
      case 'upsertAccount':
        sendResponse(await upsertRecord('Account', msg.fields,
          `SELECT Id FROM Account WHERE Name='${msg.fields.Name}'`));
        break;
      case 'setClientId':
        await chrome.storage.local.set({ sf_client_id: msg.clientId });
        sendResponse({ success: true });
        break;
      case 'getClientId':
        sendResponse({ clientId: (await chrome.storage.local.get('sf_client_id')).sf_client_id || '' });
        break;
      default:
        sendResponse({ error: 'Unknown action: ' + msg.action });
    }
  })();
  return true; // keep port open for async
});
