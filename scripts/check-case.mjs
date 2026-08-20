/**
 * Guards against the deploy failure that only appears on Linux.
 *
 *   node scripts/check-case.mjs
 *
 * Windows and macOS have case-insensitive filesystems, so `import './Foo.js'`
 * happily resolves a file actually named `foo.ts`. Linux does not, and Render
 * builds on Linux - so a project that compiles perfectly on the machine it was
 * written on can fail at build time on the host, minutes before a demo, with an
 * error that points at a file which visibly exists.
 *
 * This walks every relative import and checks it against the real directory
 * listing, character for character.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const ROOTS = ['server/src', 'web/src', 'shared/src'];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name).split('\\').join('/');
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}

for (const root of ROOTS) walk(root);

const IMPORT_RE = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;
let problems = 0;

for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const src = readFileSync(file, 'utf8');
  const dir = dirname(file);

  let match;
  while ((match = IMPORT_RE.exec(src)) !== null) {
    const spec = match[1];
    const base = join(dir, spec).split('\\').join('/');

    // TypeScript resolves a `.js` specifier to the `.ts` source beside it.
    const candidates = [
      base,
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.js$/, '.tsx'),
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
    ];

    const resolved = candidates.find((c) => files.includes(c));
    if (!resolved) {
      console.log(`  UNRESOLVED     ${file} -> ${spec}`);
      problems++;
      continue;
    }

    // The list above was built from real directory entries, so an exact match
    // there already proves the casing is right. Re-reading the directory guards
    // against any normalisation the path helpers might have applied.
    const onDisk = readdirSync(dirname(resolved));
    const name = basename(resolved);
    if (!onDisk.includes(name)) {
      const near = onDisk.filter((f) => f.toLowerCase() === name.toLowerCase());
      console.log(`  CASE MISMATCH  ${file} -> ${spec}   disk has: ${near.join(', ')}`);
      problems++;
    }
  }
}

console.log(
  problems === 0
    ? `  clean: ${files.length} files, every relative import resolves with exact casing`
    : `  ${problems} problem(s) — these will fail on Linux`,
);
process.exit(problems === 0 ? 0 : 1);
