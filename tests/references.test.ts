import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '../src/mcp/tools/index.js';
import { pageCopy, headline } from '../src/core/copy.js';

/**
 * Static scan of the source for tool names that do not exist.
 *
 * The runtime tests can only check the strings they can reach. Two dangling
 * names slipped past them for exactly that reason:
 *
 *   - `seo_mentions_find` sat in a `degraded_to` string in config.ts. The
 *     capability test walked `tools[]` and never looked at the prose.
 *   - `seo_gsc_list_sites` (real name: `seo_gsc_sites`) sat in two error
 *     remedies in providers/gsc.ts, on a path that only runs when Search
 *     Console credentials are configured. No test can reach it without keys.
 *
 * Both would misfire at the worst possible moment: an agent reads a remedy
 * precisely when it is already blocked. Sending it to a tool that does not
 * exist turns one failure into two. A grep over the source needs no
 * credentials and no network, so it covers the paths the suite cannot run.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('tool name references in source', () => {
  it('every seo_*/pseo_* identifier in src refers to a registered tool', () => {
    const registered = new Set(TOOL_NAMES);
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(30); // guard: the walker must actually find files

    const dangling: string[] = [];
    let total = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        for (const match of line.match(/\b(?:seo|pseo)_[a-z_]+\b/g) ?? []) {
          total++;
          if (!registered.has(match)) {
            dangling.push(`${match} at ${file.slice(SRC.length + 1)}:${index + 1}`);
          }
        }
      }
    }

    // Guard against the regex silently matching nothing and the test passing vacuously.
    expect(total).toBeGreaterThan(50);
    expect(dangling, `source references nonexistent tool(s):\n  ${dangling.join('\n  ')}`).toHaveLength(0);
  });
});

describe('source files are plain text', () => {
  it('contains no control bytes that make text tools treat a file as binary', () => {
    // store/diff.ts had a literal NUL byte as an issue-key delimiter. It worked,
    // but grep and ripgrep classify such a file as binary and skip it silently,
    // so every text search over the repo missed that file — including searches
    // used to audit it. The delimiter is now written as the escape \u0000, which
    // is the identical runtime value in plain-text source.
    const files = sourceFiles(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const [i, byte] of bytes.entries()) {
        // Allow tab (9), LF (10), CR (13); reject other C0 controls and DEL.
        if (byte === 9 || byte === 10 || byte === 13) continue;
        if (byte < 32 || byte === 127) {
          offenders.push(`${file.slice(SRC.length + 1)} byte 0x${byte.toString(16)} at offset ${i}`);
          break;
        }
      }
    }
    expect(offenders, `control bytes found:\n  ${offenders.join('\n  ')}`).toHaveLength(0);
  });
});

describe('page copy lives in one place', () => {
  // The same defect was fixed three times before the pattern registered:
  // pseo/index.ts, keywords/cluster.ts and content/brief.ts each held their own
  // English title/heading/meta literals, so a Spanish keyword set came back with
  // "Compare options for ...", "Compared & Reviewed" and "Frequently Asked
  // Questions". They now share core/copy.ts. This guard is what stops a fourth.
  const GENERATORS = ['pseo/index.ts', 'keywords/cluster.ts', 'content/brief.ts'];

  // Phrases that are page copy, not agent instructions. Deliberately narrow: the
  // point is to catch a new template literal, not to police prose in comments.
  const COPY_PHRASES = [
    'Frequently Asked Questions',
    'Complete Guide',
    'Compared & Reviewed',
    'Which Option Should You Choose',
    'Quick Answer',
    'Definition & Examples',
    'Pricing & Plans',
    'Compare options for',
    'Get started with',
    'Everything you need to know about',
  ];

  it('keeps page-copy templates out of the generating modules', () => {
    const offenders: string[] = [];
    for (const rel of GENERATORS) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        // Comments explain the history and are allowed to quote the old strings.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const phrase of COPY_PHRASES) {
          if (code.includes(phrase)) offenders.push(`${rel}:${index + 1} → ${phrase}`);
        }
      }
    }
    expect(offenders, `page copy found outside core/copy.ts:\n  ${offenders.join('\n  ')}`).toHaveLength(0);
  });

  it('and core/copy.ts actually defines them, so the check is not vacuous', () => {
    const copy = readFileSync(join(SRC, 'core/copy.ts'), 'utf8');
    for (const phrase of COPY_PHRASES) {
      expect(copy.includes(phrase), `core/copy.ts is missing ${phrase}`).toBe(true);
    }
  });

  it('every English template has a Spanish counterpart', () => {
    // A missing Spanish key would silently fall back to English page copy.
    const en = pageCopy('en');
    const es = pageCopy('es');
    expect(Object.keys(es.sections).sort()).toEqual(Object.keys(en.sections).sort());
    expect(Object.keys(es.title).sort()).toEqual(Object.keys(en.title).sort());
    expect(Object.keys(es.meta).sort()).toEqual(Object.keys(en.meta).sort());
    // And they must actually differ, not be copy-pasted English.
    expect(es.sections.faq).not.toBe(en.sections.faq);
    expect(es.title.guide('x')).not.toBe(en.title.guide('x'));
    expect(es.meta.commercial('x')).not.toBe(en.meta.commercial('x'));
  });
});

describe('headline casing goes through one helper', () => {
  // The phrase guard above cannot catch this class: proposing "Software De
  // Facturacion Para Monotributistas" as a Spanish page title is a *casing*
  // bug, not a wrong phrase. seo_page_optimize did exactly that, because
  // buildTitle called titleCase directly. Any module that emits page copy must
  // route casing through headline(), which takes the language.
  const COPY_MODULES = [
    'content/optimize.ts', 'content/brief.ts', 'pseo/index.ts', 'keywords/cluster.ts',
  ];

  it('never calls titleCase directly to build page copy', () => {
    const offenders: string[] = [];
    for (const rel of COPY_MODULES) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '');
        if (!/\btitleCase(?:Keyword)?\(/.test(code)) continue;
        // Allowed: the definition itself, and passing it *into* headline().
        if (/function titleCase/.test(code)) continue;
        if (/,\s*titleCase\s*\)/.test(code)) continue;
        offenders.push(`${rel}:${index + 1} → ${code.trim()}`);
      }
    }
    expect(offenders, `titleCase used directly on page copy:\n  ${offenders.join('\n  ')}`).toHaveLength(0);
  });

  it('and headline actually differs by language, so routing through it matters', () => {
    expect(headline('software de facturacion', 'en', (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())))
      .toBe('Software De Facturacion');
    expect(headline('software de facturacion', 'es', (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())))
      .toBe('Software de facturacion');
  });
});
