// content.js — MV3 content script
// Injects a floating sidebar button and panel into LinkedIn pages.
// Uses chrome.runtime.sendMessage to communicate with background.js.
// No inline event handlers; no eval; CSP-safe.

(function () {
  'use strict';

  // Prevent double-injection
  if (document.getElementById('lsf-root')) return;

  // ── State ────────────────────────────────────────────────────────────────

  let panelOpen = false;
  let pageType  = detectPageType();

  // ── Helpers ──────────────────────────────────────────────────────────────

  function detectPageType() {
    const url = location.href;
    if (url.includes('/company/')) return 'company';
    if (url.includes('/in/'))      return 'person';
    return 'other';
  }

  function msg(action, payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ action, ...payload }, resolve));
  }

  function scrapeProfile() {
    const fullName = document.querySelector('h1')?.innerText?.trim() || '';
    const parts    = fullName.split(' ');
    const firstName = parts[0] || '';
    const lastName  = parts.slice(1).join(' ') || '';

    const headline  = document.querySelector('.text-body-medium')?.innerText?.trim() || '';
    const company   = document.querySelector('.inline-show-more-text--is-collapsed')?.innerText?.trim()
                   || document.querySelector('.pv-text-details__right-panel-item-text')?.innerText?.trim()
                   || '';
    const email     = document.querySelector('a[href^="mailto:"]')?.href?.replace('mailto:', '') || '';
    const phone     = document.querySelector('span[aria-label*="phone"]')?.innerText?.trim() || '';
    const location  = document.querySelector('.text-body-small.inline.t-black--light.break-words')?.innerText?.trim() || '';

    return { firstName, lastName, headline, company, email, phone, location, url: location.href };
  }

  function scrapeCompany() {
    const name        = document.querySelector('h1')?.innerText?.trim() || '';
    const website     = document.querySelector('a[data-field="website_url"]')?.href || '';
    const industry    = document.querySelector('[data-field="industry"]')?.innerText?.trim()
                     || document.querySelector('.org-top-card-summary-info-list__info-item')?.innerText?.trim() || '';
    const size        = document.querySelector('[data-field="company_size"]')?.innerText?.trim()
                     || document.querySelector('.org-about-company-module__company-size-definition')?.innerText?.trim() || '';
    const description = document.querySelector('.org-about-us-organization-description__text')?.innerText?.trim()
                     || document.querySelector('p[data-field="description"]')?.innerText?.trim() || '';
    const hq          = document.querySelector('[data-field="hq_address"]')?.innerText?.trim()
                     || document.querySelector('.org-top-card-summary-info-list__info-item:last-child')?.innerText?.trim() || '';
    const employees   = parseInt(size.replace(/[^0-9]/g, '')) || 0;

    return { name, website, industry, size, description, hq, employees, url: location.href };
  }

  // ── Sidebar HTML ─────────────────────────────────────────────────────────

  function buildSidebar() {
    const root = document.createElement('div');
    root.id = 'lsf-root';

    // Trigger button (floating)
    const trigger = document.createElement('button');
    trigger.id = 'lsf-trigger';
    trigger.title = 'Send to Salesforce';
    trigger.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.15 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.06 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 16z"/>
      </svg>`;

    // Panel
    const panel = document.createElement('div');
    panel.id = 'lsf-panel';
    panel.innerHTML = buildPanelHTML();

    root.appendChild(trigger);
    root.appendChild(panel);
    return root;
  }

  function buildPanelHTML() {
    const isPerson  = pageType === 'person';
    const isCompany = pageType === 'company';

    return `
      <div id="lsf-header">
        <span id="lsf-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#00a1e0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15H9V8h2v9zm4 0h-2V8h2v9z"/></svg>
          Salesforce Sync
        </span>
        <button id="lsf-close" title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div id="lsf-auth-section" style="display:none">
        <p class="lsf-note">Connect your Salesforce account to start syncing.</p>
        <button class="lsf-btn lsf-btn-primary" id="lsf-auth-btn">Connect Salesforce</button>
      </div>

      <div id="lsf-form-section" style="display:none">

        ${isPerson ? `
        <div class="lsf-tabs">
          <button class="lsf-tab active" data-tab="lead">Lead</button>
          <button class="lsf-tab" data-tab="contact">Contact</button>
        </div>

        <div id="lsf-tab-lead" class="lsf-tab-content">
          <div class="lsf-field-row">
            <div class="lsf-field">
              <label>First Name</label>
              <input type="text" id="lsf-first-name" placeholder="First Name"/>
            </div>
            <div class="lsf-field">
              <label>Last Name</label>
              <input type="text" id="lsf-last-name" placeholder="Last Name"/>
            </div>
          </div>
          <div class="lsf-field">
            <label>Company</label>
            <input type="text" id="lsf-company" placeholder="Company"/>
          </div>
          <div class="lsf-field">
            <label>Title</label>
            <input type="text" id="lsf-title" placeholder="Job Title"/>
          </div>
          <div class="lsf-field">
            <label>Email</label>
            <input type="email" id="lsf-email" placeholder="Email"/>
          </div>
          <div class="lsf-field-row">
            <div class="lsf-field">
              <label>Phone</label>
              <input type="text" id="lsf-phone" placeholder="Phone"/>
            </div>
            <div class="lsf-field">
              <label>Mobile</label>
              <input type="text" id="lsf-mobile" placeholder="Mobile"/>
            </div>
          </div>
          <div class="lsf-field">
            <label>LinkedIn URL</label>
            <input type="text" id="lsf-linkedin-url" placeholder="LinkedIn Profile URL"/>
          </div>
          <div class="lsf-field">
            <label>Notes</label>
            <textarea id="lsf-notes" placeholder="Notes…" rows="3"></textarea>
          </div>
          <button class="lsf-btn lsf-btn-primary" id="lsf-save-lead">Send to Salesforce</button>
        </div>

        <div id="lsf-tab-contact" class="lsf-tab-content" style="display:none">
          <div class="lsf-field-row">
            <div class="lsf-field">
              <label>First Name</label>
              <input type="text" id="lsf-c-first-name" placeholder="First Name"/>
            </div>
            <div class="lsf-field">
              <label>Last Name</label>
              <input type="text" id="lsf-c-last-name" placeholder="Last Name"/>
            </div>
          </div>
          <div class="lsf-field">
            <label>Account</label>
            <select id="lsf-c-account">
              <option value="">— select account —</option>
            </select>
          </div>
          <div class="lsf-field">
            <label>Email</label>
            <input type="email" id="lsf-c-email" placeholder="Email"/>
          </div>
          <div class="lsf-field-row">
            <div class="lsf-field">
              <label>Phone</label>
              <input type="text" id="lsf-c-phone" placeholder="Phone"/>
            </div>
            <div class="lsf-field">
              <label>Mobile</label>
              <input type="text" id="lsf-c-mobile" placeholder="Mobile"/>
            </div>
          </div>
          <div class="lsf-field">
            <label>LinkedIn URL</label>
            <input type="text" id="lsf-c-linkedin-url" placeholder="LinkedIn Profile URL"/>
          </div>
          <button class="lsf-btn lsf-btn-primary" id="lsf-save-contact">Send to Salesforce</button>
        </div>
        ` : ''}

        ${isCompany ? `
        <div class="lsf-field">
          <label>Company Name</label>
          <input type="text" id="lsf-co-name" placeholder="Company Name"/>
        </div>
        <div class="lsf-field">
          <label>Website</label>
          <input type="text" id="lsf-co-website" placeholder="https://"/>
        </div>
        <div class="lsf-field">
          <label>Industry</label>
          <input type="text" id="lsf-co-industry" placeholder="Industry"/>
        </div>
        <div class="lsf-field">
          <label>Employees</label>
          <input type="number" id="lsf-co-employees" placeholder="Number of Employees"/>
        </div>
        <div class="lsf-field">
          <label>Billing Street</label>
          <input type="text" id="lsf-co-address" placeholder="HQ Address"/>
        </div>
        <div class="lsf-field">
          <label>Description</label>
          <textarea id="lsf-co-description" placeholder="Description…" rows="3"></textarea>
        </div>
        <div class="lsf-field">
          <label>LinkedIn URL</label>
          <input type="text" id="lsf-co-linkedin-url" placeholder="LinkedIn Company URL"/>
        </div>
        <button class="lsf-btn lsf-btn-primary" id="lsf-save-account">Send to Salesforce</button>
        ` : ''}

      </div>

      <div id="lsf-toast" class="lsf-toast" aria-live="polite"></div>
    `;
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }
  function val(id) { const el = $(id); return el ? el.value.trim() : ''; }
  function setVal(id, v) { const el = $(id); if (el) el.value = v; }

  function showToast(text, type = 'success') {
    const t = $('lsf-toast');
    if (!t) return;
    t.textContent = text;
    t.className = `lsf-toast lsf-toast-${type} lsf-toast-visible`;
    setTimeout(() => t.classList.remove('lsf-toast-visible'), 3800);
  }

  function setLoading(btnId, loading) {
    const btn = $(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? 'Sending…' : 'Send to Salesforce';
  }

  // ── Auth flow ─────────────────────────────────────────────────────────────

  async function checkAuth() {
    const session = await msg('getSession');
    if (session?.sf_access_token) {
      showFormSection();
    } else {
      showAuthSection();
    }
  }

  function showAuthSection() {
    $('lsf-auth-section').style.display = '';
    $('lsf-form-section').style.display = 'none';
  }

  function showFormSection() {
    $('lsf-auth-section').style.display = 'none';
    $('lsf-form-section').style.display = '';
    prefill();
    if (pageType === 'person') loadAccounts();
  }

  // ── Pre-fill ──────────────────────────────────────────────────────────────

  function prefill() {
    if (pageType === 'person') {
      const d = scrapeProfile();
      setVal('lsf-first-name', d.firstName);
      setVal('lsf-last-name',  d.lastName);
      setVal('lsf-company',    d.company);
      setVal('lsf-title',      d.headline);
      setVal('lsf-email',      d.email);
      setVal('lsf-phone',      d.phone);
      setVal('lsf-linkedin-url', location.href);
      setVal('lsf-c-first-name', d.firstName);
      setVal('lsf-c-last-name',  d.lastName);
      setVal('lsf-c-email',      d.email);
      setVal('lsf-c-phone',      d.phone);
      setVal('lsf-c-linkedin-url', location.href);
    } else if (pageType === 'company') {
      const d = scrapeCompany();
      setVal('lsf-co-name',       d.name);
      setVal('lsf-co-website',    d.website);
      setVal('lsf-co-industry',   d.industry);
      setVal('lsf-co-employees',  d.employees || '');
      setVal('lsf-co-address',    d.hq);
      setVal('lsf-co-description', d.description);
      setVal('lsf-co-linkedin-url', location.href);
    }
  }

  async function loadAccounts() {
    const result = await msg('getAccounts');
    const select = $('lsf-c-account');
    if (!select) return;
    (result?.records || []).forEach(({ Id, Name }) => {
      const opt = document.createElement('option');
      opt.value = Id;
      opt.textContent = Name;
      select.appendChild(opt);
    });
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  function wireEvents(root) {
    // Close panel
    root.querySelector('#lsf-close')?.addEventListener('click', () => togglePanel(false));

    // Trigger button
    root.querySelector('#lsf-trigger')?.addEventListener('click', () => togglePanel(!panelOpen));

    // Auth
    $('lsf-auth-btn')?.addEventListener('click', async () => {
      const r = await msg('authorize');
      if (r?.success) showFormSection();
      else showToast(r?.message || 'Auth failed', 'error');
    });

    // Tabs
    root.querySelectorAll('.lsf-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        root.querySelectorAll('.lsf-tab').forEach(t => t.classList.remove('active'));
        root.querySelectorAll('.lsf-tab-content').forEach(c => c.style.display = 'none');
        tab.classList.add('active');
        const target = `lsf-tab-${tab.dataset.tab}`;
        $(target).style.display = '';
      });
    });

    // Save Lead
    $('lsf-save-lead')?.addEventListener('click', async () => {
      setLoading('lsf-save-lead', true);
      const fields = {
        FirstName:   val('lsf-first-name'),
        LastName:    val('lsf-last-name') || '(unknown)',
        Company:     val('lsf-company')  || '(unknown)',
        Title:       val('lsf-title'),
        Email:       val('lsf-email'),
        Phone:       val('lsf-phone'),
        MobilePhone: val('lsf-mobile'),
        Description: val('lsf-notes'),
        LeadSource:  'LinkedIn',
        LinkedIn_URL__c: val('lsf-linkedin-url'),
      };
      if (!fields.LastName) { showToast('Last Name is required', 'error'); setLoading('lsf-save-lead', false); return; }
      const r = await msg('upsertLead', { fields });
      setLoading('lsf-save-lead', false);
      r?.success ? showToast('✓ Lead saved to Salesforce!') : showToast(r?.error || 'Error saving lead', 'error');
    });

    // Save Contact
    $('lsf-save-contact')?.addEventListener('click', async () => {
      setLoading('lsf-save-contact', true);
      const fields = {
        FirstName:   val('lsf-c-first-name'),
        LastName:    val('lsf-c-last-name') || '(unknown)',
        AccountId:   val('lsf-c-account') || undefined,
        Email:       val('lsf-c-email'),
        Phone:       val('lsf-c-phone'),
        MobilePhone: val('lsf-c-mobile'),
        LeadSource:  'LinkedIn',
        LinkedIn_URL__c: val('lsf-c-linkedin-url'),
      };
      if (!fields.LastName) { showToast('Last Name is required', 'error'); setLoading('lsf-save-contact', false); return; }
      const r = await msg('upsertContact', { fields });
      setLoading('lsf-save-contact', false);
      r?.success ? showToast('✓ Contact saved to Salesforce!') : showToast(r?.error || 'Error saving contact', 'error');
    });

    // Save Account
    $('lsf-save-account')?.addEventListener('click', async () => {
      setLoading('lsf-save-account', true);
      const emp = parseInt(val('lsf-co-employees'));
      const fields = {
        Name:              val('lsf-co-name'),
        Website:           val('lsf-co-website'),
        Industry:          val('lsf-co-industry'),
        NumberOfEmployees: isNaN(emp) ? undefined : emp,
        BillingStreet:     val('lsf-co-address'),
        Description:       val('lsf-co-description'),
        LinkedIn_URL__c:   val('lsf-co-linkedin-url'),
      };
      if (!fields.Name) { showToast('Company Name is required', 'error'); setLoading('lsf-save-account', false); return; }
      const r = await msg('upsertAccount', { fields });
      setLoading('lsf-save-account', false);
      r?.success ? showToast('✓ Account saved to Salesforce!') : showToast(r?.error || 'Error saving account', 'error');
    });
  }

  function togglePanel(open) {
    panelOpen = open;
    const panel = document.getElementById('lsf-panel');
    if (panel) panel.classList.toggle('lsf-panel-open', open);
    if (open) checkAuth();
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    if (pageType === 'other') return;
    const root = buildSidebar();
    document.body.appendChild(root);
    wireEvents(root);
  }

  // Wait a tick for LinkedIn's SPA to settle
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Handle LinkedIn SPA navigation (pushState)
  let lastURL = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastURL) {
      lastURL = location.href;
      const newType = detectPageType();
      if (newType !== pageType) {
        pageType = newType;
        const old = document.getElementById('lsf-root');
        if (old) old.remove();
        panelOpen = false;
        setTimeout(init, 800);
      }
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

})();
