import { config } from '../../config';

/**
 * Structure-aware chunking (§5: "section/clause boundaries, 300–500 tokens,
 * ~10% overlap, heading path prefixed").
 *
 * Deterministic by design: the same text must produce the same chunks and the same
 * `content_hash` on every run, otherwise the embedding cache (§9) would miss on
 * every re-ingest and the freshness monitor would report a change that is only a
 * re-render.
 *
 * A token is estimated at 4 characters, the same estimate the context budget uses,
 * because the tokenizer that matters is the provider's and it is not available
 * offline. Chunks therefore aim at the middle of the band, so ±20% tokenizer error
 * still lands inside 300–500 for most prose.
 */

/** Chars per token, matching `estimateTokens` in the provider layer. */
export const CHARS_PER_TOKEN = 4;
/** Aim for the middle of the §5 band so tokenizer variation cannot push us out of it. */
const TARGET_RATIO = 0.8;

export interface ChunkDraft {
  ordinal: number;
  /** Heading path prefixed onto the text, so a quoted chunk carries its own location. */
  content: string;
  headingPath: string | null;
  section: string | null;
  tokenCount: number;
  /** 1-based line offsets in the cleaned document, for the chunk inspector. */
  firstLine: number;
  lastLine: number;
  overlapTokens: number;
  /** 1-based page numbers when the source had them. */
  pages: number[];
}

export interface ChunkOptions {
  minTokens?: number;
  maxTokens?: number;
  overlapRatio?: number;
}

/** Heading line emitted by the extractors (`## Title`) or Markdown (`## Title`). */
const HEADING = /^(#{1,6})\s+(.+)$/;
/** Clause numbers as printed in Indian Standards: `Clause 4.2.1`, `cl. 4.2`, `Section 3`. */
const CLAUSE_LEADING = /^\s*(?:clause|sub-clause|section|cl\.?)\s+([0-9]+(?:\.[0-9]+)*)\b/i;
/** A bare dotted number at the head of a line: `4.2.1 The material shall …`. */
const CLAUSE_BARE = /^\s*([0-9]+(?:\.[0-9]+){1,3})\.?\s+\S/;
const ANNEX = /^\s*ANNEX(?:EX)?\s+([A-Z0-9]+)\b/i;
const PAGE_MARKER = /^\{\{PAGE\}\}$/;

interface Block {
  kind: 'heading' | 'clause' | 'text';
  level: number;
  text: string;
  firstLine: number;
  lastLine: number;
  page: number | null;
}

export function chunkDocument(text: string, opts: ChunkOptions = {}): ChunkDraft[] {
  const c = config();
  const minTokens = opts.minTokens ?? c.CHUNK_MIN_TOKENS;
  const maxTokens = opts.maxTokens ?? c.CHUNK_MAX_TOKENS;
  const overlapRatio = opts.overlapRatio ?? c.CHUNK_OVERLAP_RATIO;
  const targetTokens = Math.round(minTokens + (maxTokens - minTokens) * TARGET_RATIO);

  const blocks = parseBlocks(text);
  if (blocks.length === 0) return [];

  const drafts: ChunkDraft[] = [];
  const headingPath: { level: number; text: string }[] = [];
  let current: Block[] = [];
  let currentTokens = 0;
  /** Carried into the next chunk as the ~10% overlap (§5). */
  let tailSentences: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const pathText = headingPath.map((h) => h.text).join(' > ') || null;
    const built = buildChunk(current, tailSentences, overlapRatio, maxTokens, pathText);
    drafts.push({
      ordinal: drafts.length + 1,
      content: built.content,
      headingPath: pathText,
      section: leadingSection(current),
      tokenCount: Math.ceil(built.content.length / CHARS_PER_TOKEN),
      firstLine: current[0]!.firstLine,
      lastLine: current[current.length - 1]!.lastLine,
      overlapTokens: built.overlapTokens,
      pages: collectPages(current),
    });
    tailSentences = built.tailSentences;
    current = [];
    currentTokens = 0;
  };

  /**
   * The heading path and the overlap line are part of the stored chunk, so they have
   * to be paid for out of the band. Without this reserve, a long path plus a 10 %
   * overlap pushed the final `tokenCount` a little over CHUNK_MAX_TOKENS — the §5
   * band is a contract with retrieval (a 500-token chunk is quoted whole), and
   * "about 500" on the way out is how a 3,000-token context budget quietly becomes 3,400.
   */
  const reserveTokens = (): number => {
    const path = headingPath.map((h) => h.text).join(' > ');
    // The worst-case overlap is budgeted even where there is no tail yet, because the
    // tail only exists for later chunks — reserving the actual tail here is what let
    // chunks 2..n overflow the band while chunk 1 fit.
    const overlapChars = Math.floor(maxTokens * overlapRatio * CHARS_PER_TOKEN) + 14;
    const chars = (path.length > 0 ? path.length + 4 : 0) + overlapChars;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  };

  for (const block of blocks) {
    const bodyMaxTokens = Math.max(minTokens, maxTokens - reserveTokens());
    const bodyTargetTokens = Math.min(targetTokens, bodyMaxTokens);
    if (block.kind === 'heading') {
      // A new heading closes the previous chunk: never split a clause from its
      // heading, and never merge two differently-numbered clauses into one block.
      flush();
      while (headingPath.length > 0 && (headingPath.at(-1)?.level ?? 0) >= block.level) headingPath.pop();
      headingPath.push({ level: block.level, text: block.text.replace(/^#+\s*/, '') });
      continue;
    }

    const blockTokens = Math.ceil(block.text.length / CHARS_PER_TOKEN);

    if (blockTokens > bodyMaxTokens) {
      // A block longer than the band (a table, a long list) is split by sentence so
      // an unusual source can never produce an out-of-spec chunk.
      flush();
      for (const piece of splitLongBlock(block, bodyTargetTokens, bodyMaxTokens)) {
        current = [piece];
        flush();
      }
      continue;
    }

    // The band's ceiling is a hard cap and wins over the floor: retrieval quotes a
    // chunk whole, six of them fill the 3,000-token context budget exactly, so an
    // over-max chunk is a real overflow. A chunk below `minTokens` is only a soft
    // miss (the last chunk of every short document is), which is why the order here
    // matters more than the count of small chunks.
    if (currentTokens + blockTokens > bodyMaxTokens) flush();
    current.push(block);
    currentTokens += blockTokens;
    if (currentTokens >= bodyTargetTokens && currentTokens >= minTokens) flush();
  }
  flush();

  return drafts.filter((d) => d.tokenCount > 0);
}

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let page: number | null = null;
  let buffer: string[] = [];
  let bufferStart = 0;

  const closeBuffer = (endLine: number) => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (joined.length === 0) return;
    const isClause = CLAUSE_LEADING.test(joined) || CLAUSE_BARE.test(joined) || ANNEX.test(joined);
    blocks.push({
      kind: isClause ? 'clause' : 'text',
      level: 0,
      text: joined,
      firstLine: bufferStart,
      page,
      lastLine: endLine,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (PAGE_MARKER.test(trimmed)) {
      closeBuffer(i);
      // The marker is a page increment, not content: a page number is provenance,
      // and a reviewer needs it to find the paragraph in the original PDF.
      page = (page ?? 0) + 1;
      continue;
    }
    if (trimmed.length === 0) {
      closeBuffer(i + 1);
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      closeBuffer(i);
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        text: trimmed,
        firstLine: i + 1,
        page,
        lastLine: i + 1,
      });
      continue;
    }
    // A clause number at the start of a line always begins a new block, even
    // without a blank line above it — PDF text layers rarely have blank lines.
    const startsClause = CLAUSE_LEADING.test(trimmed) || CLAUSE_BARE.test(trimmed) || ANNEX.test(trimmed);
    if (startsClause && buffer.length > 0) closeBuffer(i);
    if (buffer.length === 0) bufferStart = i + 1;
    buffer.push(trimmed);
  }
  closeBuffer(lines.length);
  return blocks;
}

interface BuiltChunk {
  content: string;
  overlapTokens: number;
  tailSentences: string[];
}

function buildChunk(
  blocks: Block[],
  previousTail: string[],
  overlapRatio: number,
  maxTokens: number,
  pathText: string | null,
): BuiltChunk {
  const body = blocks.map((b) => b.text).join('\n\n').trim();
  const overlapBudgetChars = Math.floor(maxTokens * overlapRatio * CHARS_PER_TOKEN);

  let overlapText = '';
  if (previousTail.length > 0 && overlapBudgetChars > 0) {
    const tailText = previousTail.join(' ').replace(/\s+/g, ' ').trim();
    if (tailText.length <= overlapBudgetChars) {
      overlapText = tailText;
    } else {
      // A standards sentence is routinely longer than 10 % of a 300-token chunk, so
      // "take whole sentences while they fit" would silently emit *no* overlap at all.
      // A word-aligned suffix of the tail is what the band actually allows, and it is
      // still verbatim text from the source (R4: overlap is a repeat, never a rewrite).
      let start = tailText.length - overlapBudgetChars;
      const space = tailText.indexOf(' ', start);
      const candidate = space > -1 ? tailText.slice(space + 1).trim() : '';
      overlapText = candidate.length >= 8 ? candidate : tailText.slice(start).trim();
    }
  }

  const content = [
    pathText ? `[${pathText}]` : '',
    overlapText ? `…continued: ${overlapText}` : '',
    body,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  // The tail for the *next* chunk is the last sentences of this one, sized to the
  // overlap budget (§5 "~10% overlap").
  const tail: string[] = [];
  let tailChars = 0;
  const tailBudgetChars = Math.max(80, Math.floor(maxTokens * overlapRatio * CHARS_PER_TOKEN));
  for (const sentence of splitSentences(body).reverse()) {
    if (tailChars + sentence.length > tailBudgetChars && tail.length > 0) break;
    tail.unshift(sentence);
    tailChars += sentence.length + 1;
  }

  return {
    content,
    overlapTokens: Math.ceil(overlapText.length / CHARS_PER_TOKEN),
    tailSentences: tail,
  };
}

function splitLongBlock(block: Block, targetTokens: number, maxTokens: number): Block[] {
  const sentences = splitSentences(block.text);
  if (sentences.length <= 1) {
    // Nothing to split on (one enormous sentence, e.g. a table row): cut on
    // whitespace near the boundary rather than mid-token.
    const chars = maxTokens * CHARS_PER_TOKEN;
    const out: Block[] = [];
    let rest = block.text;
    while (rest.length > chars) {
      const cut = rest.lastIndexOf(' ', chars) || chars;
      out.push({ ...block, text: rest.slice(0, cut).trim() });
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) out.push({ ...block, text: rest });
    return out;
  }

  const limit = targetTokens * CHARS_PER_TOKEN;
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > limit && current.length > 0) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current.length === 0 ? sentence : `${current} ${sentence}`;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces.map((text) => ({ ...block, text }));
}

/** Splits on Latin and Devanagari terminators; the danda `।` ends a Hindi sentence. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function leadingSection(blocks: Block[]): string | null {
  for (const b of blocks) {
    const clause = CLAUSE_LEADING.exec(b.text);
    if (clause?.[1]) return `Clause ${clause[1]}`;
    const bare = CLAUSE_BARE.exec(b.text);
    if (bare?.[1]) return bare[1];
    const annex = ANNEX.exec(b.text);
    if (annex?.[1]) return `Annexure ${annex[1]}`;
  }
  return null;
}

function collectPages(blocks: Block[]): number[] {
  const pages = new Set<number>();
  for (const b of blocks) if (b.page !== null) pages.add(b.page);
  return [...pages].sort((a, b) => a - b);
}
