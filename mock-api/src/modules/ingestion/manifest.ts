import { DOC_TYPES, type DocType, SUPPORTED_LANGUAGES, type Language } from '../../constants';
import type { IngestionSpec } from './pipeline';

/**
 * The P0 knowledge manifest (§PART B P0, `knowledge/manifest.csv`).
 *
 * Columns: `source_url, title, doc_type, publisher, access, license_note,
 * language, category, priority, status`.
 *
 * The parser is strict for a reason. A manifest row becomes provenance for a cited
 * standard, so a row that guesses — a missing title, an invented doc_type, a
 * restricted item with no licence note — is refused with the line and column
 * named, not defaulted. Silently filling in a plausible value is how fabricated
 * data enters a knowledge base (R10).
 */

const HEADER_ALIASES: Record<string, string> = {
  source_url: 'source_url',
  url: 'source_url',
  title: 'title',
  doc_type: 'doc_type',
  doctype: 'doc_type',
  publisher: 'publisher',
  access: 'access',
  access_level: 'access',
  license_note: 'license_note',
  licence_note: 'license_note',
  language: 'language',
  lang: 'language',
  category: 'category',
  priority: 'priority',
  status: 'status',
  standard_no: 'standard_no',
  standard_number: 'standard_no',
  published_date: 'published_date',
  revised_date: 'revised_date',
  copyright_status: 'copyright_status',
};

const REQUIRED_COLUMNS = ['source_url', 'title', 'doc_type', 'publisher', 'access', 'license_note', 'language', 'status'];

/** Spoken synonyms, mapped to the §7 controlled vocabulary — never a free-text passthrough. */
const DOC_TYPE_ALIASES: Record<string, DocType> = {
  standard: 'STANDARD',
  is: 'STANDARD',
  qco: 'QCO',
  'quality control order': 'QCO',
  procedure: 'PROCEDURE',
  'certification procedure': 'PROCEDURE',
  guide: 'GUIDE',
  guidelines: 'GUIDE',
  faq: 'FAQ',
  notification: 'NOTIFICATION',
  'gazette notification': 'NOTIFICATION',
  laboratory_list: 'LABORATORY_LIST',
  'lab list': 'LABORATORY_LIST',
  laboratories: 'LABORATORY_LIST',
  handbook: 'HANDBOOK',
  'code of practice': 'HANDBOOK',
  scheme: 'SCHEME',
  other: 'OTHER',
};

export interface ManifestRejection {
  line: number;
  field?: string;
  reason: string;
}

export interface ManifestParseResult {
  specs: Array<Pick<IngestionSpec, 'kind' | 'url' | 'title' | 'docType' | 'language' | 'publisher' | 'licenseNote' | 'accessLevel' | 'standardNo' | 'publishedDate' | 'revisedDate' | 'copyrightStatus' | 'autoApprove'>>;
  rejected: ManifestRejection[];
  /** Rows whose `status` is not `approved`: queued for a human, never ingested silently. */
  deferred: number;
  columns: string[];
}

/** RFC4180 CSV: quoted fields, `""` escapes, embedded newlines, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const push = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    push();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      push();
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      pushRow();
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function parseManifest(csv: string): ManifestParseResult {
  const rows = parseCsv(csv);
  const rejected: ManifestRejection[] = [];
  const specs: ManifestParseResult['specs'] = [];
  let deferred = 0;

  if (rows.length === 0) {
    return { specs, rejected: [{ line: 0, reason: 'The file contains no rows.' }], deferred: 0, columns: [] };
  }

  const header = rows[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, '_')] ?? '');
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      specs,
      rejected: [{ line: 1, reason: `Missing required column(s): ${missing.join(', ')}.` }],
      deferred: 0,
      columns: header,
    };
  }

  const at = (row: string[], column: string): string => {
    const index = header.indexOf(column);
    return index === -1 ? '' : (row[index] ?? '').trim();
  };

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const line = r + 1;
    const raw = {
      sourceUrl: at(row, 'source_url'),
      title: at(row, 'title'),
      docType: at(row, 'doc_type'),
      publisher: at(row, 'publisher'),
      access: at(row, 'access'),
      licenseNote: at(row, 'license_note'),
      language: at(row, 'language'),
      status: at(row, 'status'),
      standardNo: at(row, 'standard_no'),
      publishedDate: at(row, 'published_date'),
      revisedDate: at(row, 'revised_date'),
      copyrightStatus: at(row, 'copyright_status'),
    };

    if (!raw.title) {
      rejected.push({ line, field: 'title', reason: 'A row with no title cannot be cited, so it is not accepted.' });
      continue;
    }
    if (!raw.publisher) {
      rejected.push({ line, field: 'publisher', reason: 'Provenance is required (R2): publisher is empty.' });
      continue;
    }

    const access = raw.access.toLowerCase();
    if (access !== 'open' && access !== 'restricted') {
      rejected.push({ line, field: 'access', reason: `access must be open or restricted, not "${raw.access}".` });
      continue;
    }

    const docTypeKey = raw.docType.toLowerCase().replace(/\s+/g, ' ');
    const docType: DocType | undefined =
      (DOC_TYPES as readonly string[]).includes(raw.docType.toUpperCase())
        ? (raw.docType.toUpperCase() as DocType)
        : DOC_TYPE_ALIASES[docTypeKey];
    if (!docType) {
      rejected.push({
        line,
        field: 'doc_type',
        reason: `"${raw.docType}" is not a known doc_type. Accepted: ${DOC_TYPES.join(', ')} (or their plain-language synonyms).`,
      });
      continue;
    }

    const languageKey = raw.language.toLowerCase();
    const language: Language | undefined = (SUPPORTED_LANGUAGES as readonly string[]).includes(languageKey)
      ? (languageKey as Language)
      : undefined;
    if (!language) {
      rejected.push({ line, field: 'language', reason: `language must be en or hi, not "${raw.language}".` });
      continue;
    }

    const status = raw.status.toLowerCase();
    if (!['approved', 'draft', 'queued', 'pending'].includes(status)) {
      rejected.push({ line, field: 'status', reason: `status must be approved, draft, queued or pending, not "${raw.status}".` });
      continue;
    }

    if (access === 'restricted' && raw.licenseNote.length === 0) {
      rejected.push({
        line,
        field: 'license_note',
        reason: 'A restricted item must state its licence terms, otherwise the row invites someone to go and fetch it (R11).',
      });
      continue;
    }

    let url: string | null = null;
    if (raw.sourceUrl) {
      try {
        const parsed = new URL(raw.sourceUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          rejected.push({ line, field: 'source_url', reason: 'source_url must be http(s).' });
          continue;
        }
        url = parsed.href;
      } catch {
        rejected.push({ line, field: 'source_url', reason: `"${raw.sourceUrl}" is not a URL. Do not invent one (R10).` });
        continue;
      }
    } else if (access === 'open') {
      rejected.push({
        line,
        field: 'source_url',
        reason: 'An open item needs a source URL, or its freshness cannot be checked and its citation cannot link anywhere.',
      });
      continue;
    }

    const copyright = raw.copyrightStatus.toUpperCase();
    const copyrightStatus =
      copyright === 'PUBLIC' || copyright === 'GOVERNMENT' || copyright === 'LICENSED' || copyright === 'RESTRICTED' || copyright === 'UNKNOWN'
        ? copyright
        : 'UNKNOWN';

    // A rejected date must abort the row as well, otherwise the file would be
    // ingested with a null date *and* reported as rejected.
    const published = isoDate(raw.publishedDate, line, 'published_date');
    const revised = isoDate(raw.revisedDate, line, 'revised_date');
    if (published.error) rejected.push(published.error);
    if (revised.error) rejected.push(revised.error);
    if (published.error || revised.error) continue;

    // Only an `approved` row becomes an ingestion spec. Counting the others and then
    // ingesting them anyway would make the `status` column decorative — and the
    // `deferredRows` figure in the response is what tells the operator the row is
    // waiting for a person rather than lost.
    if (status !== 'approved') {
      deferred += 1;
      continue;
    }

    specs.push({
      kind: 'manifest',
      url: url ?? undefined,
      title: raw.title,
      docType,
      language,
      publisher: raw.publisher,
      licenseNote: raw.licenseNote || null,
      accessLevel: access === 'restricted' ? 'restricted' : 'open',
      standardNo: raw.standardNo || null,
      publishedDate: published.value ?? undefined,
      revisedDate: revised.value ?? undefined,
      copyrightStatus,
      // Only an already-approved manifest row auto-approves, and only the
      // CONTENT_MANAGER who submitted it becomes the reviewer of record.
      autoApprove: status === 'approved' && access === 'open',
    });
  }

  return { specs, rejected, deferred, columns: header };
}

/**
 * Dates are validated rather than coerced: a misread date on a standard is a false
 * fact about which version is current (R10). The result carries its own rejection
 * instead of a module-level buffer, so two parses cannot interleave.
 */
function isoDate(value: string, line: number, field: string): { value: string | null; error: ManifestRejection | null } {
  if (!value) return { value: null, error: null };
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!match) return { value: null, error: { line, field, reason: `"${value}" is not a YYYY-MM-DD date.` } };
  const iso = match[1] + '-' + match[2]!.padStart(2, '0') + '-' + match[3]!.padStart(2, '0');
  const parsed = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== Number(match[1])) {
    return { value: null, error: { line, field, reason: `"${value}" is not a real calendar date.` } };
  }
  if (parsed.getTime() > Date.now()) {
    return { value: null, error: { line, field, reason: `"${value}" is in the future.` } };
  }
  return { value: iso, error: null };
}
