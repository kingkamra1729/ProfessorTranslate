/**
 * Renders docs/onepager.html to a PDF using the installed Chrome.
 *
 *   npm run onepager:pdf
 *
 * Headless Chrome rather than a PDF library because the page is already styled
 * for print - light palette restored, page breaks guarded, colour preserved -
 * and re-implementing that in a generator would mean maintaining the design
 * twice and having the two drift.
 *
 * The header, footer and page numbers are suppressed deliberately: Chrome's
 * defaults stamp the source URL across the bottom of every page, which on a
 * file:// render means printing the author's home directory onto a document
 * meant to be sent to strangers.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'docs/onepager.html');
const output = resolve(root, 'docs/Suvidha-onepager.pdf');
const profile = resolve(root, 'node_modules/.cache/chrome-print');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('  No Chrome or Edge found. Open docs/onepager.html and print to PDF instead.');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`  Missing ${source}`);
  process.exit(1);
}

rmSync(profile, { recursive: true, force: true });

execFileSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    // Web fonts load asynchronously; without a budget the render can start
    // before Spectral and Noto Devanagari arrive and fall back silently.
    '--virtual-time-budget=12000',
    '--run-all-compositor-stages-before-draw',
    '--no-pdf-header-footer',
    `--print-to-pdf=${output}`,
    pathToFileURL(source).href,
  ],
  { stdio: 'inherit' },
);

console.log(`  ${output}  (${(statSync(output).size / 1024).toFixed(0)} kB)`);
