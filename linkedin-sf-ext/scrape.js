// scrape.js — pure DOM-scraping helpers for LinkedIn pages.
// Loaded as a content script BEFORE content.js (they share one isolated-world
// scope), and exposed as `LSFScrape` so content.js can call them. Kept free of
// chrome.* / side effects so it can be unit-tested in jsdom.

(function (root) {
  'use strict';

  function detectPageType() {
    const url = location.href;
    if (url.includes('/company/')) return 'company';
    if (url.includes('/in/'))      return 'person';
    return 'other';
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
    const loc       = document.querySelector('.text-body-small.inline.t-black--light.break-words')?.innerText?.trim() || '';

    return { firstName, lastName, headline, company, email, phone, location: loc, url: location.href };
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

  root.LSFScrape = { detectPageType, scrapeProfile, scrapeCompany };
})(typeof self !== 'undefined' ? self : globalThis);
