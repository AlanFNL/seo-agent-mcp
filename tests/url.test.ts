import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  registrableDomain,
  domainOf,
  sameSite,
  slashInsensitiveKey,
  slugToWords,
  slugify,
  looksLikeHtml,
  pathSegments,
} from '../src/core/url.js';

describe('normalizeUrl', () => {
  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(normalizeUrl('https://a.com/p?utm_source=x&id=5&gclid=abc')).toBe('https://a.com/p?id=5');
  });

  it('sorts query parameters so equivalent URLs converge', () => {
    expect(normalizeUrl('https://a.com/p?b=2&a=1')).toBe(normalizeUrl('https://a.com/p?a=1&b=2'));
  });

  it('drops the fragment and default port, and lowercases the host', () => {
    expect(normalizeUrl('https://EXAMPLE.com:443/path#section')).toBe('https://example.com/path');
  });

  it('collapses index.html to the directory root', () => {
    expect(normalizeUrl('https://a.com/index.html')).toBe('https://a.com/');
  });

  it('collapses duplicate slashes from bad template concatenation', () => {
    expect(normalizeUrl('https://a.com//blog///post')).toBe('https://a.com/blog/post');
  });

  it('PRESERVES the trailing slash', () => {
    // Stripping it made the crawler request the non-canonical form; most static
    // hosts then 308 back, which the audit reported as a redirect problem.
    expect(normalizeUrl('https://a.com/docs/')).toBe('https://a.com/docs/');
    expect(normalizeUrl('https://a.com/docs')).toBe('https://a.com/docs');
    expect(normalizeUrl('https://a.com/docs/')).not.toBe(normalizeUrl('https://a.com/docs'));
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('/about', 'https://a.com/blog/post')).toBe('https://a.com/about');
    expect(normalizeUrl('../x', 'https://a.com/a/b/c')).toBe('https://a.com/a/x');
  });

  it('rejects non-http schemes and garbage', () => {
    expect(normalizeUrl('mailto:x@y.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('slashInsensitiveKey', () => {
  it('treats the two trailing-slash forms as one identity', () => {
    expect(slashInsensitiveKey('https://a.com/docs/')).toBe(slashInsensitiveKey('https://a.com/docs'));
  });

  it('keeps the root path distinct from a named path', () => {
    expect(slashInsensitiveKey('https://a.com/')).not.toBe(slashInsensitiveKey('https://a.com/docs'));
  });

  it('does not merge different paths', () => {
    expect(slashInsensitiveKey('https://a.com/a')).not.toBe(slashInsensitiveKey('https://a.com/b'));
  });
});

describe('registrableDomain', () => {
  it('handles simple domains and subdomains', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('blog.example.com')).toBe('example.com');
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.c.example.com')).toBe('example.com');
  });

  it('handles multi-part public suffixes', () => {
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('example.com.au')).toBe('example.com.au');
  });

  it('treats platform subdomains as distinct sites', () => {
    // Two different projects on the same host are not the same site.
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
    expect(registrableDomain('bob.github.io')).toBe('bob.github.io');
    expect(registrableDomain('alice.github.io')).not.toBe(registrableDomain('bob.github.io'));
  });
});

describe('sameSite', () => {
  it('treats subdomains of one registrable domain as the same site', () => {
    expect(sameSite('https://blog.example.com/a', 'https://www.example.com/b')).toBe(true);
  });

  it('separates different domains', () => {
    expect(sameSite('https://example.com', 'https://other.com')).toBe(false);
  });

  it('is false when either side is unparseable', () => {
    expect(sameSite('not a url at all', 'https://example.com')).toBe(false);
  });
});

describe('slug helpers', () => {
  it('reads a slug back as words', () => {
    expect(slugToWords('https://a.com/blog/best-crm-software-2026')).toBe('best crm software 2026');
    expect(slugToWords('https://a.com/blog/my_post.html')).toBe('my post');
  });

  it('slugifies arbitrary text safely', () => {
    expect(slugify('Best CRM Software (2026)!')).toBe('best-crm-software-2026');
    expect(slugify('Café Münchën')).toBe('cafe-munchen');
    expect(slugify('  --leading and trailing--  ')).toBe('leading-and-trailing');
  });

  it('lists path segments without empties', () => {
    expect(pathSegments('https://a.com//blog//post/')).toEqual(['blog', 'post']);
  });
});

describe('looksLikeHtml', () => {
  it('accepts pages and rejects assets', () => {
    expect(looksLikeHtml('https://a.com/page')).toBe(true);
    expect(looksLikeHtml('https://a.com/page.html')).toBe(true);
    expect(looksLikeHtml('https://a.com/img.png')).toBe(false);
    expect(looksLikeHtml('https://a.com/doc.pdf')).toBe(false);
    expect(looksLikeHtml('https://a.com/app.js')).toBe(false);
  });
});
