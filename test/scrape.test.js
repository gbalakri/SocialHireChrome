// @vitest-environment jsdom
// test/scrape.test.js — tests the pure DOM scrapers in scrape.js against
// sample LinkedIn-shaped markup. Also pins the page-type routing.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../linkedin-sf-ext/scrape.js'; // side-effect: attaches LSFScrape to the global

const { detectPageType, scrapeProfile, scrapeCompany } = globalThis.LSFScrape;

function setUrl(href) {
  vi.stubGlobal('location', { href });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('detectPageType', () => {
  it('classifies company / person / other from the URL', () => {
    setUrl('https://www.linkedin.com/company/acme/');
    expect(detectPageType()).toBe('company');
    setUrl('https://www.linkedin.com/in/john-doe/');
    expect(detectPageType()).toBe('person');
    setUrl('https://www.linkedin.com/feed/');
    expect(detectPageType()).toBe('other');
  });
});

describe('scrapeProfile', () => {
  it('extracts name, headline, contact info and the page URL', () => {
    setUrl('https://www.linkedin.com/in/john-doe/');
    document.body.innerHTML = `
      <h1>John Doe</h1>
      <div class="text-body-medium">Engineer at Acme</div>
      <span class="inline-show-more-text--is-collapsed">Acme Inc</span>
      <a href="mailto:john@acme.com">email</a>
      <span aria-label="Contact phone number">555-1234</span>
      <span class="text-body-small inline t-black--light break-words">San Francisco</span>
    `;
    const d = scrapeProfile();
    expect(d.firstName).toBe('John');
    expect(d.lastName).toBe('Doe');
    expect(d.headline).toBe('Engineer at Acme');
    expect(d.company).toBe('Acme Inc');
    expect(d.email).toBe('john@acme.com');
    expect(d.phone).toBe('555-1234');
    expect(d.location).toBe('San Francisco');
    // Regression: url must be the page URL, not undefined (the old local
    // `location` string shadowed the global and broke `location.href`).
    expect(d.url).toBe('https://www.linkedin.com/in/john-doe/');
  });

  it('degrades to empty strings when fields are absent', () => {
    setUrl('https://www.linkedin.com/in/empty/');
    const d = scrapeProfile();
    expect(d.firstName).toBe('');
    expect(d.lastName).toBe('');
    expect(d.email).toBe('');
  });
});

describe('scrapeCompany', () => {
  it('extracts company fields and parses the employee count', () => {
    setUrl('https://www.linkedin.com/company/acme/');
    document.body.innerHTML = `
      <h1>Acme Corporation</h1>
      <a data-field="website_url" href="https://acme.com">site</a>
      <span data-field="industry">Software</span>
      <span data-field="company_size">5000</span>
      <p data-field="description">We make things.</p>
      <span data-field="hq_address">1 Market St</span>
    `;
    const d = scrapeCompany();
    expect(d.name).toBe('Acme Corporation');
    expect(d.website).toContain('acme.com');
    expect(d.industry).toBe('Software');
    expect(d.description).toBe('We make things.');
    expect(d.hq).toBe('1 Market St');
    expect(d.employees).toBe(5000);
    expect(d.url).toBe('https://www.linkedin.com/company/acme/');
  });
});
