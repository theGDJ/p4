import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/en';
import { hi } from '@/i18n/hi';

/**
 * Translation parity.
 *
 * `hi.ts` is already typed as `TranslationShape` so the compiler catches a missing
 * key. This suite catches what types cannot: an accidentally empty Hindi string, an
 * untranslated copy of the English, a `{{placeholder}}` that exists in one language
 * but not the other, and list-length drift at runtime.
 */

/** Every non-test source file the UI can render from. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'i18n' || entry === 'test') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(tsx?|jsx?)$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

type Node = string | readonly unknown[] | { readonly [key: string]: Node };

function walk(node: Node, prefix: string, out: string[]): void {
  if (typeof node === 'string') {
    out.push(prefix);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item as Node, `${prefix}[${index}]`, out));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    walk(value as Node, prefix ? `${prefix}.${key}` : key, out);
  }
}

function keysOf(root: unknown): string[] {
  const out: string[] = [];
  walk(root as Node, '', out);
  return out;
}

const enKeys = keysOf(en);
const hiKeys = keysOf(hi);

function at(path: string, root: unknown): unknown {
  return path.split(/\.|\[|\]/).filter(Boolean).reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    if (/^\d+$/.test(part)) return (acc as unknown[])[Number(part)];
    return (acc as Record<string, unknown>)[part];
  }, root);
}

/** Strings that are intentionally identical in both languages. */
const ALLOWED_IDENTICAL = new Set([
  'common.appName', // product name
  'common.hindi', // the Hindi option is always written in Hindi, in both UIs
  'common.english', // likewise: language names are shown in their own script
  'auth.emailPlaceholder', // an RFC-style example address, not prose
  'footer.apiDocs',
  'footer.sourceCode',
]);

/** Proper nouns and technical tokens that stay in Latin script in Hindi copy too. */
const LATIN_OK = /^(BIS|IS|API|ADMIN|USER|CONTENT_MANAGER|APPROVED|KB|MSME|LLM_PROVIDER|BIS-Saathi|Informational)$/;

describe('i18n parity (en ↔ hi)', () => {
  it('has the same set of keys, including list positions', () => {
    expect(hiKeys).toEqual(enKeys);
  });

  it('has no key missing from either language', () => {
    expect(enKeys.filter((k) => !hiKeys.includes(k))).toEqual([]);
    expect(hiKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
  });

  it('has no empty or whitespace-only translation', () => {
    const empty: string[] = [];
    for (const key of enKeys) {
      const e = at(key, en);
      const h = at(key, hi);
      if (typeof e === 'string' && e.trim().length === 0) empty.push(`en:${key}`);
      if (typeof h === 'string' && h.trim().length === 0) empty.push(`hi:${key}`);
    }
    expect(empty).toEqual([]);
  });

  it('does not leave English strings untranslated into Hindi', () => {
    const untranslated: string[] = [];
    for (const key of enKeys) {
      if (ALLOWED_IDENTICAL.has(key)) continue;
      const e = at(key, en);
      const h = at(key, hi);
      if (typeof e !== 'string' || typeof h !== 'string') continue;
      if (e === h && !LATIN_OK.test(e.trim())) untranslated.push(key);
    }
    // A few strings are deliberately language-neutral (standard numbers, the R4
    // and R5 sentences in English contexts). Anything listed here must be justified.
    expect(untranslated).toEqual([]);
  });

  it('keeps interpolation placeholders in sync', () => {
    const placeholder = /\{\{\s*(\w+)\s*\}\}/g;
    const mismatched: string[] = [];
    for (const key of enKeys) {
      const e = at(key, en);
      const h = at(key, hi);
      if (typeof e !== 'string' || typeof h !== 'string') continue;
      const eVars = [...e.matchAll(placeholder)].map((m) => m[1]).sort();
      const hVars = [...h.matchAll(placeholder)].map((m) => m[1]).sort();
      if (JSON.stringify(eVars) !== JSON.stringify(hVars)) mismatched.push(`${key}: ${eVars} vs ${hVars}`);
    }
    expect(mismatched).toEqual([]);
  });

  it('preserves list lengths', () => {
    const listKeys = enKeys.filter((k) => /\[\d+\]$/.test(k)).map((k) => k.replace(/\[\d+\]$/, ''));
    const unique = [...new Set(listKeys)];
    for (const key of unique) {
      const e = at(key, en) as unknown[];
      const h = at(key, hi) as unknown[];
      expect(Array.isArray(e), `en.${key} should be a list`).toBe(true);
      expect(Array.isArray(h), `hi.${key} should be a list`).toBe(true);
      expect(h.length, `${key} length`).toBe(e.length);
    }
    expect(unique.length).toBeGreaterThan(0);
  });

  it('keeps the exact R4 and R5 strings intact in both languages', () => {
    // R4/R5 are contractual sentences: they must not drift with copy edits.
    expect(en.chat.informational).toBe('Informational — verify against current official sources');
    expect(hi.chat.informational).toBe('सूचनात्मक — कृपया वर्तमान आधिकारिक स्रोतों से सत्यापित करें');
    expect(en.common.disclaimer).toBe(en.chat.informational);
  });

  it('contains no raw i18n keys as values', () => {
    // Derived from the dictionary itself, so a newly added section cannot slip past
    // this check the way a hand-maintained list of names would.
    const prefixes = Object.keys(en).join('|');
    const leaked = new RegExp(`^(${prefixes})\\.[A-Za-z0-9_.]+`);
    for (const key of enKeys) {
      for (const [language, root] of [['en', en], ['hi', hi]] as const) {
        const value = at(key, root);
        if (typeof value === 'string') expect(value, `${language}:${key}`).not.toMatch(leaked);
      }
    }
  });

  it('has a translation for every key the components actually ask for', () => {
    // The real failure mode of a typed dictionary: `t()` takes a string, so a key that
    // no longer exists does not fail to compile — it renders the key itself to the user.
    // Two admin headings did exactly that while this page was being built, and only a
    // render test caught it. This makes the whole source tree the assertion.
    const staticKey = /\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_\[\]]+)+)'/g;
    const dynamicPrefix = /\bt\(\s*`([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\$\{/g;
    const missing: string[] = [];
    const used = new Set<string>();
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(staticKey)) used.add(match[1] as string);
      for (const match of text.matchAll(dynamicPrefix)) {
        const prefix = match[1] as string;
        const node = at(prefix, en);
        if (node === undefined) missing.push(`${prefix}* (in ${file})`);
      }
    }
    for (const key of used) {
      if (at(key, en) === undefined) missing.push(`${key} (en)`);
      if (at(key, hi) === undefined) missing.push(`${key} (hi)`);
    }
    expect(missing, `untranslated keys referenced by components:\n${missing.join('\n')}`).toEqual([]);
    // Sanity: the scan has to be finding keys at all, or this test is theatre.
    expect(used.size).toBeGreaterThan(60);
  });
});
