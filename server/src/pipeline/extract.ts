/**
 * Pulls plain text out of an uploaded course file.
 *
 * The glossary is only as good as the material it is built from, and the
 * material a lecturer actually has is a PDF of last year's notes or a chapter
 * saved from a browser - not a URL and not something they will paste. Accepting
 * a file removes the last excuse for starting a lecture with an empty term
 * list.
 *
 * Text formats are decoded here rather than in the browser so the two paths
 * behave identically, and so a file that is text-with-a-strange-extension still
 * works.
 */

export interface ExtractedDocument {
  text: string;
  /** How the text was obtained, reported to the professor. */
  method: 'pdf' | 'text';
  /** Pages, for a PDF. Undefined otherwise. */
  pages?: number;
}

/** Extensions we decode as plain text. Anything unknown is sniffed instead. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'rtf', 'tex', 'org', 'rst', 'html', 'htm',
]);

/** Upper bound on a single upload, before base64 expansion. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * True when a buffer looks like human-readable text.
 *
 * Used for files whose extension we do not recognise. A run of NUL bytes or a
 * high proportion of undecodable characters means binary, and feeding binary to
 * the extractor produces a glossary full of mojibake.
 */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;

  const decoded = sample.toString('utf8');
  const replacementChars = (decoded.match(/�/g) ?? []).length;
  return replacementChars / Math.max(1, decoded.length) < 0.05;
}

/** Strips the markup that survives an HTML or RTF save. */
function stripMarkup(text: string, ext: string): string {
  if (ext === 'html' || ext === 'htm') {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
  if (ext === 'rtf') {
    return text.replace(/\\'[0-9a-f]{2}/gi, ' ').replace(/\\[a-z]+-?\d*\s?/gi, ' ').replace(/[{}]/g, ' ');
  }
  return text;
}

/** Collapses the whitespace that PDF extraction and markup stripping leave behind. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocument(
  fileName: string,
  buffer: Buffer,
): Promise<ExtractedDocument> {
  if (buffer.length === 0) throw new Error('That file is empty');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
    );
  }

  const ext = extensionOf(fileName);

  if (ext === 'pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    // Imported lazily so a server that is never asked to open a PDF never pays
    // for loading a PDF engine.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    try {
      const result = await parser.getText();
      const text = tidy(result.text ?? '');

      if (!text) {
        throw new Error(
          'No text found. This looks like a scanned PDF — the pages are images, not text. ' +
            'Paste the terms manually, or export a text-based PDF.',
        );
      }
      return { text, method: 'pdf', pages: result.pages?.length };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('No text found')) throw err;
      throw new Error(
        `Could not read that PDF: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      // The parser holds a worker and document handles; a lecture-hall server
      // opening files all day would leak them.
      await parser.destroy().catch(() => {});
    }
  }

  if (TEXT_EXTENSIONS.has(ext) || looksLikeText(buffer)) {
    const text = tidy(stripMarkup(buffer.toString('utf8'), ext));
    if (!text) throw new Error('That file contains no readable text');
    return { text, method: 'text' };
  }

  throw new Error(
    `Cannot read a .${ext || 'binary'} file yet. Supported: PDF, and text formats ` +
      '(.txt, .md, .csv, .html). For Word documents, use "Save as PDF" first.',
  );
}
