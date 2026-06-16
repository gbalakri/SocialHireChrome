// background.js — MV3 Service Worker
// Handles Salesforce OAuth (Connected App / JWT flow) and REST API proxying.
// All sensitive credentials live only in chrome.storage.session (cleared on browser close).

const SF_LOGIN_URL   = 'https://login.salesforce.com';
const OAUTH_CALLBACK = chrome.identity.getRedirectURL('salesforce');

// ── OAuth ──────────────────────────────────────────────────────────────────

async function getClientId() {
  const { sf_client_id } = await chrome.storage.local.get('sf_client_id');
  return sf_client_id || null;
}

async function launchOAuth() {
  const clientId = await getClientId();
  if (!clientId) {
    return { error: 'NO_CLIENT_ID', message: 'Please set your Salesforce Connected App Client ID in extension options.' };
  }

  const authURL =
    `${SF_LOGIN_URL}/services/oauth2/authorize` +
    `?response_type=token` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}` +
    `&scope=api%20refresh_token`;

  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url: authURL, interactive: true },
      async (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          resolve({ error: 'AUTH_FAILED', message: chrome.runtime.lastError?.message || 'Auth cancelled.' });
          return;
        }
        // Token is in the hash fragment
        const hash = new URL(redirectUrl).hash.substring(1);
        const params = Object.fromEntries(new URLSearchParams(hash));
        if (!params.access_token) {
          resolve({ error: 'NO_TOKEN', message: 'No access token returned.' });
          return;
        }
        await chrome.storage.session.set({
          sf_access_token:  params.access_token,
          sf_instance_url:  decodeURIComponent(params.instance_url || params.id?.split('/id/')[0] || ''),
          sf_token_type:    params.token_type,
        });
        resolve({ success: true });
      }
    );
  });
}

async function getSession() {
  return chrome.storage.session.get(['sf_access_token', 'sf_instance_url']);
}

async function logout() {
  await chrome.storage.session.remove(['sf_access_token', 'sf_instance_url', 'sf_token_type']);
  return { success: true };
}

// ── Salesforce REST API ────────────────────────────────────────────────────

async function sfRequest(method, path, body) {
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
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function soqlQuery(query) {
  const path = `/services/data/v59.0/query?q=${encodeURIComponent(query)}`;
  return sfRequest('GET', path);
}

async function createRecord(objectType, fields) {
  const path = `/services/data/v59.0/sobjects/${objectType}/`;
  const result = await sfRequest('POST', path, fields);
  if (result.data?.id) return { success: true, id: result.data.id };
  return { error: result.data?.[0]?.message || 'Create failed', raw: result };
}

async function updateRecord(objectType, id, fields) {
  const path = `/services/data/v59.0/sobjects/${objectType}/${id}`;
  const result = await sfRequest('PATCH', path, fields);
  if (result.status === 204) return { success: true, id };
  return { error: result.data?.[0]?.message || 'Update failed', raw: result };
}

async function upsertRecord(objectType, fields, uniqueQuery) {
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

async function getAccounts() {
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
