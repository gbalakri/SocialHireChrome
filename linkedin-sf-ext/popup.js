// popup.js — MV3 popup script (no inline handlers allowed)
'use strict';

function msg(action, payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ action, ...payload }, resolve));
}

async function init() {
  const session = await msg('getSession');
  const clientId = (await msg('getClientId')).clientId;

  if (session?.sf_access_token) {
    document.getElementById('view-unauth').style.display = 'none';
    document.getElementById('view-auth').style.display = '';
  } else {
    document.getElementById('view-auth').style.display = 'none';
    document.getElementById('view-unauth').style.display = '';
    if (!clientId) {
      document.getElementById('no-client-id-warning').style.display = '';
    }
  }
}

document.getElementById('btn-authorize').addEventListener('click', async () => {
  const btn = document.getElementById('btn-authorize');
  btn.disabled = true;
  btn.textContent = 'Authorizing…';
  const r = await msg('authorize');
  if (r?.success) {
    await init();
  } else {
    btn.disabled = false;
    btn.textContent = 'Authorize with Salesforce';
    alert(r?.message || 'Authorization failed. Check your Client ID in Settings.');
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await msg('logout');
  await init();
});

init();
