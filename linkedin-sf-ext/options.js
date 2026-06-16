// options.js
'use strict';

// Show the OAuth callback URL so the user can copy it into their Connected App
const callbackUrl = chrome.identity.getRedirectURL('salesforce');
document.getElementById('callback-url').textContent = callbackUrl;
document.getElementById('callback-url-2').textContent = callbackUrl;

// Load saved client ID
chrome.runtime.sendMessage({ action: 'getClientId' }, (r) => {
  if (r?.clientId) document.getElementById('client-id').value = r.clientId;
});

document.getElementById('btn-save').addEventListener('click', () => {
  const clientId = document.getElementById('client-id').value.trim();
  chrome.runtime.sendMessage({ action: 'setClientId', clientId }, () => {
    const s = document.getElementById('status');
    s.style.display = '';
    setTimeout(() => s.style.display = 'none', 2500);
  });
});
