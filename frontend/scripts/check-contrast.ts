/**
 * Contrast gate for master spec §11 ("Verify body-text contrast >= 4.5:1").
 *
 * Reads the real token values out of `src/index.css` rather than duplicating them,
 * so the check cannot drift from what ships. Exits non-zero on any failure, so it
 * can run in CI and in `npm run contrast`.
 *
 * WCAG 2.2 rules applied:
 *   1.4.3  Contrast (Minimum)   — body text >= 4.5:1
 *   1.4.11 Non-text Contrast    — icons, borders, focus indicators >= 3:1
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(here, '../src/index.css'), 'utf8');

/* ------------------------------------------------------------- colour maths */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6) throw new Error(`Bad hex: ${hex}`);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** sRGB -> linear channel (WCAG relative luminance definition). */
function linearise(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/* --------------------------------------------------------------- token read */

/** Pulls the `:root { --name: #hex; }` block out of the stylesheet. */
function readRootTokens(source: string): Record<string, string> {
  const rootMatch = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootMatch) throw new Error('No :root block found in src/index.css');
  const tokens: Record<string, string> = {};
  for (const line of rootMatch[1]!.split('\n')) {
    const m = line.match(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/);
    if (m) tokens[m[1]!] = m[2]!;
  }
  if (Object.keys(tokens).length === 0) throw new Error('No hex tokens found in :root');
  return tokens;
}

const tokens = readRootTokens(css);

function token(name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`Missing design token --${name} in src/index.css`);
  return value;
}

/* ------------------------------------------------------------- the assertions */

interface TextPair {
  fg: string;
  bg: string;
  why: string;
}

/** Every pairing used for BODY TEXT. Must clear 4.5:1 (WCAG 1.4.3). */
const textPairs: TextPair[] = [
  { fg: 'ink', bg: 'paper', why: 'primary body text on the page' },
  { fg: 'ink', bg: 'paper-raised', why: 'primary body text on cards' },
  { fg: 'ink-muted', bg: 'paper', why: 'secondary/muted body text' },
  { fg: 'ink-muted', bg: 'paper-raised', why: 'secondary text on cards' },
  { fg: 'ink-faint', bg: 'paper', why: 'faintest permitted text (timestamps, hints)' },
  { fg: 'teal', bg: 'paper', why: 'links and accent text' },
  { fg: 'teal', bg: 'paper-raised', why: 'links on cards' },
  { fg: 'teal-hover', bg: 'paper', why: 'hovered link text' },
  { fg: 'verified', bg: 'paper', why: '"Verified" label text' },
  { fg: 'verified', bg: 'verified-soft', why: '"Verified" badge text on its tint' },
  { fg: 'error', bg: 'paper', why: 'error text' },
  { fg: 'error', bg: 'error-soft', why: 'error banner text on its tint' },
  { fg: 'warn', bg: 'warn-soft', why: '"Needs verification" badge text on its tint' },
  { fg: 'warn', bg: 'paper', why: '"Needs verification" inline text' },
  { fg: 'ink-inverse', bg: 'navy', why: 'text on the navy header/primary button' },
  { fg: 'ink-inverse', bg: 'teal', why: 'text on teal buttons' },
  { fg: 'ink', bg: 'teal-soft', why: 'text on the teal tint' },
  { fg: 'ink', bg: 'navy-soft', why: 'text on the navy tint' },
  { fg: 'ink', bg: 'paper-sunken', why: 'text in sunken wells (code, snippets)' },
];

interface NonTextPair {
  fg: string;
  bg: string;
  why: string;
}

/** Icons, borders and focus indicators. Must clear 3:1 (WCAG 1.4.11). */
const nonTextPairs: NonTextPair[] = [
  { fg: 'saffron', bg: 'paper', why: 'saffron icon/border accent (text use is forbidden)' },
  { fg: 'saffron', bg: 'paper-raised', why: 'saffron icon on cards' },
  { fg: 'saffron', bg: 'saffron-soft', why: 'saffron icon on its tint' },
  { fg: 'line-strong', bg: 'paper', why: 'strong hairline rules and input borders' },
  { fg: 'focus-ring', bg: 'paper', why: 'keyboard focus ring' },
  { fg: 'focus-ring', bg: 'paper-raised', why: 'keyboard focus ring on cards' },
  { fg: 'teal', bg: 'paper', why: 'teal icons' },
  { fg: 'verified', bg: 'paper', why: 'verified check icon' },
  { fg: 'error', bg: 'paper', why: 'error icon' },
];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3.0;

let failures = 0;
let checks = 0;

/** Prints as it goes so the output stays grouped under its own heading. */
function check(fgName: string, bgName: string, min: number, why: string): void {
  const fg = token(fgName);
  const bg = token(bgName);
  const ratio = contrastRatio(fg, bg);
  const pass = ratio >= min;
  checks += 1;
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${ratio.toFixed(2).padStart(6)}:1  need ${min.toFixed(1)}  ${fg} on ${bg}  ${why}`,
  );
}

console.log('\n=== WCAG 2.2 contrast gate (master spec §11) ===\n');
console.log('--- body text: 1.4.3 Contrast (Minimum), >= 4.5:1 ---');
for (const p of textPairs) check(p.fg, p.bg, AA_TEXT, p.why);

console.log('--- non-text: 1.4.11 Non-text Contrast, >= 3:1 ---');
for (const p of nonTextPairs) check(p.fg, p.bg, AA_NON_TEXT, p.why);

/*
 * §11 restricts saffron to icons and borders. Enforce that in the stylesheet too,
 * so nobody can add a saffron text colour and quietly break 1.4.3.
 */
const saffronAsText = /color\s*:\s*var\(--saffron\)|text-saffron(?![\w-])/.test(css);
console.log('--- §11 constraint: saffron is for icons and borders only ---');
if (saffronAsText) {
  failures += 1;
  checks += 1;
  console.log('  FAIL  saffron is used as a text colour; §11 allows it for icons/borders only');
} else {
  checks += 1;
  console.log('  PASS  saffron is not used as a text colour');
}

const saffronRatio = contrastRatio(token('saffron'), token('paper'));
console.log(`\nNote: --saffron is ${saffronRatio.toFixed(2)}:1 on paper — above the 3:1 non-text`);
console.log('      threshold but below 4.5:1, which is exactly why §11 bars it from text.');
console.log(`      Text-safe amber alternative: --warn (${contrastRatio(token('warn'), token('paper')).toFixed(2)}:1).`);

if (failures > 0) {
  console.error(`\n${failures} contrast check(s) FAILED.\n`);
  process.exit(1);
}
console.log(`\nAll ${checks} contrast checks passed.\n`);
