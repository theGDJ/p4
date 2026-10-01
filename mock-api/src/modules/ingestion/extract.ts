import { logger } from '../../lib/logger';

/**
 * Content extraction (§5 "extract (PDF text; OCR only if scanned; HTML main
 * content)").
 *
 * HTML: only the main article, with scripts, styles, navigation and — importantly
 * — *hidden* nodes removed. A page can carry text a reader cannot see; keeping it
 * would let a source page inject content that is retrieved and cited as if the
 * document said it visibly.
 *
 * PDF: text layer only. A scanned PDF has no text layer, and this deployment does
 * not run an OCR engine, so that case is reported as `needsOcr` and the job fails
 * with a reason (R8) rather than ingesting an empty document that looks complete.
 */

export type SourceFormat = 'html' | 'pdf' | 'text' | 'markdown';

export interface ExtractedDocument {
  /** Structural text. Headings are rendered as `# …` so the chunker can see them. */
  text: string;
  format: SourceFormat;
  /** Page count when the source has pages. */
  pages: number | null;
  /** Document title as found in the source, for the reviewer to compare with the manifest. */
  foundTitle: string | null;
  needsOcr: boolean;
  characters: number;
  warnings: string[];
}

export function detectFormat(contentType: string, filenameHint?: string): SourceFormat {
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
  const name = (filenameHint ?? '').toLowerCase();
  if (ct === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (ct === 'text/html' || ct === 'application/xhtml+xml' || /\.x?html?$/.test(name)) return 'html';
  if (ct === 'text/markdown' || /\.(md|markdown)$/.test(name)) return 'markdown';
  return 'text';
}

/** A text layer this thin means the "PDF" is a scan, not a document. */
const MIN_CHARS_PER_PAGE = 40;

/** The PDF magic number, checked before any parser is trusted. */
const PDF_MAGIC = '%PDF-';

export async function extract(body: Buffer, contentType: string, filenameHint?: string): Promise<ExtractedDocument> {
  const declared = detectFormat(contentType, filenameHint);
  const looksLikePdf = body.subarray(0, 5).toString('latin1').startsWith(PDF_MAGIC);
  const warnings: string[] = [];
  let format = declared;

  // A content type is something a remote server *said*, not a fact. Sniffing the magic
  // number here means a truncated download or an HTML error page served as
  // `application/pdf` is read as what it actually is and says so, instead of failing
  // inside the PDF parser with a message no reviewer can act on.
  if (declared === 'pdf' && !looksLikePdf) {
    const sniffed = body.subarray(0, 2048).toString('utf8');
    format = /<\s*(?:html|body|!doctype html)/i.test(sniffed) ? 'html' : 'text';
    warnings.push(
      `The payload was labelled ${contentType} but does not begin with ${PDF_MAGIC}, so it was read as ${format === 'html' ? 'HTML' : 'plain text'}.`,
    );
    logger.warn('ingestion payload content type did not match its magic number', { contentType, readAs: format });
  }

  if (format === 'pdf') return extractPdf(body, format);

  const text = body.toString('utf8');
  if (format === 'html') {
    const out = await extractHtml(text, format);
    return { ...out, warnings: [...warnings, ...out.warnings] };
  }
  return {
    text: text.replace(/\r\n?/g, '\n'),
    format,
    pages: null,
    foundTitle: null,
    needsOcr: false,
    characters: text.length,
    warnings,
  };
}

/* ------------------------------------------------------------------- HTML */

const DROP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'canvas',
  'audio',
  'video',
  'nav',
  'header',
  'footer',
  'aside',
];

const MAIN_SELECTORS = ['article', 'main', '[role=main]', '#content', '#main', '.content', '.main-content', '.article-body', '.entry-content'];

/**
 * The subset of the DOM this module needs, declared structurally rather than via
 * `lib.dom`, because the API package compiles without DOM types and linkedom's own
 * declarations are not a global `Document`. One cast at the parse boundary is the
 * only place the two worlds touch.
 */
interface DomElement {
  tagName: string;
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  children: ArrayLike<DomElement>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  querySelector(selector: string): DomElement | null;
  remove(): void;
}
interface DomNode {
  nodeType: number;
  textContent: string | null;
}
interface DomDocument {
  body: DomElement | null;
  documentElement: DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  querySelector(selector: string): DomElement | null;
}

/**
 * Attributes that make text invisible to a reader. A document that "says"
 * something only in `display:none` is not evidence, it is a payload.
 */
function isHidden(el: DomElement): boolean {
  if (el.hasAttribute('hidden')) return true;
  if ((el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true') return true;
  const style = (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  if (/display:none|visibility:hidden|opacity:0|font-size:0(\.0+)?(px)?/.test(style)) return true;
  const cls = (el.getAttribute('class') ?? '').toLowerCase();
  if (/(^|\s)(sr-only|visually-hidden|hidden|d-none|text-hide)(\s|$)/.test(cls)) return true;
  return false;
}

/** Element→plain text walk that preserves block structure and heading levels. */
function renderNode(node: DomElement, out: string[], headingStack: { level: number; text: string }[]): void {
  const tag = node.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      while (headingStack.length > 0 && (headingStack.at(-1)?.level ?? 0) >= level) headingStack.pop();
      headingStack.push({ level, text });
      out.push(`${'#'.repeat(level)} ${text}`);
    }
    return;
  }

  if (tag === 'table') {
    for (const row of Array.from(node.querySelectorAll('tr'))) {
      const cells = Array.from(row.querySelectorAll('th,td'))
        .map((c: DomElement) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) out.push(cells.join(' | '));
    }
    return;
  }

  if (tag === 'pre') {
    const raw = (node.textContent ?? '').replace(/\r\n?/g, '\n').trimEnd();
    if (raw.trim().length > 0) out.push(raw);
    return;
  }

  if (tag === 'li') {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0) out.push(`- ${text}`);
    return;
  }

  const children = Array.from(node.children).filter((child) => !isHidden(child));
  if (children.length === 0) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0) out.push(text);
    return;
  }

  // One sentence must stay one line. `<p>text <strong>more</strong> text</p>` used to
  // be emitted as three lines, which split standard clauses in half, hurt FTS
  // scoring and made the chunker cut mid-sentence. Inline children are therefore
  // folded into the surrounding text, and only a block child ends the line.
  let line = '';
  const flush = (): void => {
    // Fold runs of whitespace, then tidy the space a flattened inline element can
    // leave in front of punctuation (`Table 1 .`). No real document is written that
    // way, so this cannot damage text — and a stray space inside a quoted sentence
    // would break the exact-sentence check (R4/R5 compare verbatim strings).
    const text = line
      .replace(/[ \t]+/g, ' ')
      .replace(/ ([.,;:!?)\]}।,;])/g, '$1')
      .trim();
    if (text.length > 0) out.push(text);
    line = '';
  };

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      line += child.textContent ?? ' ';
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as DomElement;
    if (isHidden(el)) continue;
    if (isInline(el)) {
      line += inlineText(el);
      continue;
    }
    flush();
    renderNode(el, out, headingStack);
  }
  flush();
}

/**
 * Inline elements contribute text to the current line; everything else starts a new
 * block. An inline tag that wraps block content (a `<span>` around a section, which
 * CMS templates do produce) is treated as a block so its structure is not flattened
 * into one enormous line.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font',
  'i', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'sup', 'time', 'u', 'var', 'wbr', 'br',
]);

const BLOCK_TAGS_SELECTOR = 'p,div,li,ul,ol,table,section,article,blockquote,pre,h1,h2,h3,h4,h5,h6,figure,dl';

function isInline(el: DomElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (!INLINE_TAGS.has(tag)) return false;
  if (tag === 'br') return true;
  try {
    return el.querySelector(BLOCK_TAGS_SELECTOR) === null;
  } catch {
    return false;
  }
}

/** Flattens an inline subtree, skipping hidden descendants — a `<span style="display:none">`
 * inside a paragraph is the hidden-text attack, so `textContent` alone is not usable. */
function inlineText(node: DomNode): string {
  if (node.nodeType === 3) return node.textContent ?? ' ';
  if (node.nodeType !== 1) return '';
  const el = node as DomElement;
  if (isHidden(el)) return '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return ' ';
  if (!INLINE_TAGS.has(tag)) return el.textContent ? ` ${el.textContent} ` : '';
  let out = '';
  for (const child of Array.from(el.childNodes)) out += inlineText(child);
  return out;
}

async function extractHtml(html: string, format: SourceFormat): Promise<ExtractedDocument> {
  const { parseHTML } = await import('linkedom');
  const dom = parseHTML(html);
  const doc = dom.window.document as unknown as DomDocument;
  const warnings: string[] = [];

  for (const sel of DROP_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
  }

  let container: DomElement | null = null;
  let best = 0;
  for (const sel of MAIN_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      if (isHidden(el)) continue;
      const length = (el.textContent ?? '').trim().length;
      if (length > best) {
        best = length;
        container = el;
      }
    }
    if (container) break;
  }
  if (!container) {
    container = doc.body ?? doc.documentElement;
    warnings.push('No main-content container was identifiable, so the whole body was used.');
  }
  if (!container) {
    return { text: '', format, pages: null, foundTitle: null, needsOcr: true, characters: 0, warnings: ['The document had no body to read.'] };
  }

  const out: string[] = [];
  const headingStack: { level: number; text: string }[] = [];
  renderNode(container, out, headingStack);

  const text = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  // `title` lives in <head>, which the drop pass never touches.
  const title = (doc.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim() || null;

  if (text.length < 200) {
    warnings.push('The extracted main content is very short — check whether the page renders its text client-side.');
    logger.warn('html extraction produced little text', { characters: text.length });
  }

  return {
    text,
    format,
    pages: null,
    foundTitle: title,
    needsOcr: false,
    characters: text.length,
    warnings,
  };
}

/* -------------------------------------------------------------------- PDF */

interface PdfTextItem {
  str: string;
  transform: number[];
  height: number;
  hasEOL?: boolean;
}

/**
 * Text-layer extraction through pdf.js, with lines reconstructed from item
 * geometry (PDF has no line breaks, only positions) and a heading heuristic based
 * on glyph height relative to the page median.
 */
async function extractPdf(body: Buffer, format: SourceFormat): Promise<ExtractedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(body);
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;

  const warnings: string[] = [];
  const pageTexts: string[] = [];
  let chars = 0;

  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    if (pageNo > 500) {
      warnings.push('Only the first 500 pages were read.');
      break;
    }
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const items = (content.items as unknown as PdfTextItem[]).filter((i) => typeof i.str === 'string' && i.str.length > 0);
    const lines = groupIntoLines(items);
    const heights = lines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
    const median = heights.length > 0 ? heights[Math.floor(heights.length / 2)]! : 0;

    const rendered: string[] = [];
    for (const line of lines) {
      const trimmed = line.text.replace(/\s+/g, ' ').trim();
      if (trimmed.length === 0) continue;
      // A line noticeably taller than the body, and short, is a heading in every
      // BIS-style layout we can inspect. It is a hint for chunk boundaries only —
      // never a fact about the document.
      const isHeading = median > 0 && line.height >= median * 1.25 && trimmed.length <= 90;
      rendered.push(isHeading ? `## ${trimmed}` : trimmed);
    }
    chars += rendered.join(' ').length;
    pageTexts.push(rendered.join('\n'));
    page.cleanup();
  }

  const pages = doc.numPages;
  const text = pageTexts.filter((p) => p.length > 0).join('\n\n{{PAGE}}\n\n').trim();
  const perPage = pages > 0 ? text.length / pages : 0;
  const needsOcr = text.length === 0 || perPage < MIN_CHARS_PER_PAGE;

  if (needsOcr) {
    warnings.push(
      `No usable text layer (≈${Math.round(perPage)} characters per page over ${pages} page(s)). ` +
        'This looks like a scanned document; OCR is not part of this deployment, so nothing was ingested.',
    );
  }

  let title: string | null = null;
  try {
    const info = (await doc.getMetadata()).info as { Title?: string };
    if (typeof info.Title === 'string' && info.Title.trim().length > 0) title = info.Title.trim();
  } catch {
    // Metadata is optional; a PDF with none is still a valid document.
  }

  return {
    text,
    format,
    pages,
    foundTitle: title,
    needsOcr,
    characters: text.length,
    warnings,
  };
}

interface PdfLine {
  text: string;
  height: number;
}

/**
 * Groups items by their baseline (y = transform[5]) and orders each line left to
 * right (x = transform[4). Two items whose baselines differ by less than half a
 * line height are the same line.
 */
function groupIntoLines(items: PdfTextItem[]): PdfLine[] {
  interface Bucket {
    y: number;
    height: number;
    parts: Array<{ x: number; str: string }>;
  }
  const buckets: Bucket[] = [];

  for (const item of items) {
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const height = Math.abs(item.height ?? 0) || Math.abs(item.transform?.[3] ?? 0) || 10;
    const existing = buckets.find((b) => Math.abs(b.y - y) < Math.max(2, height * 0.5));
    if (existing) {
      existing.parts.push({ x, str: item.str });
      existing.height = Math.max(existing.height, height);
    } else {
      buckets.push({ y, height, parts: [{ x, str: item.str }] });
    }
  }

  // Top of the page first, i.e. descending y in PDF coordinates.
  return buckets
    .sort((a, b) => b.y - a.y)
    .map((b) => ({
      text: b.parts
        .sort((p, q) => p.x - q.x)
        .map((p) => p.str)
        // A single space between adjacent glyphs, none when the fragment already ends with one.
        .reduce((acc, part) => (acc.length === 0 ? part : /\s$/.test(acc) || /^\s/.test(part) ? acc + part : `${acc} ${part}`), ''),
      height: b.height,
    }));
}
