/**
 * Checks course-file extraction across the formats a lecturer actually has.
 *
 *   npx tsx src/extract.test.ts
 *
 * Includes a real PDF, generated here rather than committed, so the PDF path is
 * exercised end to end instead of being assumed to work.
 */
import { extractDocument, MAX_UPLOAD_BYTES } from './pipeline/extract.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', String(detail).slice(0, 300));
  }
}

/**
 * A minimal but valid single-page PDF containing known text.
 *
 * Hand-built because generating one needs a library this project has no other
 * use for, and a committed binary fixture is worse than twenty lines that show
 * exactly what is being parsed.
 */
function makePdf(line: string): Buffer {
  const content = `BT /F1 14 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function main() {
  console.log('\ntext formats');

  {
    const md = Buffer.from(
      '# Oscillations\n\nThe **restoring force** is proportional to displacement.\nDamping reduces amplitude.',
      'utf8',
    );
    const r = await extractDocument('notes.md', md);
    check('markdown extracted', r.method === 'text' && r.text.includes('restoring force'), r.text);
  }

  {
    const html = Buffer.from(
      '<html><head><style>p{color:red}</style></head><body><h1>Waves</h1>' +
        '<script>alert(1)</script><p>The wavelength &amp; frequency relate.</p></body></html>',
      'utf8',
    );
    const r = await extractDocument('chapter.html', html);
    check('html tags stripped', !r.text.includes('<'), r.text);
    check('script and style content dropped',
      !r.text.includes('alert') && !r.text.includes('color:red'), r.text);
    check('entities decoded', r.text.includes('&') && r.text.includes('wavelength'), r.text);
  }

  {
    // No extension, but clearly text. Should still work.
    const r = await extractDocument('syllabus', Buffer.from('Week 1: eigenvalues and eigenvectors', 'utf8'));
    check('unknown extension sniffed as text', r.method === 'text', r.text);
  }

  console.log('\npdf');
  {
    const pdf = makePdf('The restoring force is proportional to displacement');
    try {
      const r = await extractDocument('lecture.pdf', pdf);
      check('pdf text extracted', r.text.toLowerCase().includes('restoring force'), r.text.slice(0, 120));
      check('reported as pdf with a page count', r.method === 'pdf' && (r.pages ?? 0) >= 1,
        `method=${r.method} pages=${r.pages}`);
    } catch (err) {
      check('pdf text extracted', false, err instanceof Error ? err.message : err);
    }
  }

  {
    // Extension lies, magic bytes tell the truth.
    const pdf = makePdf('Angular frequency and phase');
    const r = await extractDocument('mislabelled.txt', pdf).catch(() => null);
    check('pdf detected by magic bytes despite .txt name', r?.method === 'pdf', r?.method);
  }

  console.log('\nrejections');
  {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    const r = await extractDocument('diagram.png', binary).then(() => null).catch((e: Error) => e);
    check('image rejected with a useful message',
      r instanceof Error && /cannot read a \.png/i.test(r.message), r?.message);
  }

  {
    const r = await extractDocument('empty.txt', Buffer.alloc(0)).then(() => null).catch((e: Error) => e);
    check('empty file rejected', r instanceof Error && /empty/i.test(r.message), r?.message);
  }

  {
    const huge = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41);
    const r = await extractDocument('huge.txt', huge).then(() => null).catch((e: Error) => e);
    check('oversized file rejected before parsing',
      r instanceof Error && /limit is/i.test(r.message), r?.message);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('extract test crashed:', err);
  process.exit(1);
});
