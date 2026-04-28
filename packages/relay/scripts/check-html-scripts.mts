#!/usr/bin/env tsx
/**
 * Sanity-check that every inline <script> in WEB_CLIENT_HTML and LANDING_HTML
 * is valid JavaScript. The HTML strings are TS template literals served by
 * the Cloudflare Worker — escape sequences inside them collapse at compile
 * time (e.g. `\/` → `/`, `\'` → `'`), and getting one wrong silently breaks
 * the whole page since the inline script hard-fails at parse.
 *
 * Past offenders this guard would have caught:
 *   - `replace(/\/+$/, '')`     served as `replace(//+$/, '')`  →  comment
 *   - `'you\'ll recognise'`     served with unescaped apostrophe
 *
 * The check parses each inline script with `new Function(...)` — this
 * doesn't execute it, just runs the JS parser. SyntaxErrors throw and the
 * script exits non-zero. CSP nonce placeholders (`__CSP_NONCE__`) are
 * ignored — they're attribute values, not script content.
 */

import { WEB_CLIENT_HTML } from '../src/web-client.js';
import { LANDING_HTML } from '../src/landing.js';

interface InlineScript {
  source: string;
  /** 1-based line offset within the host HTML where this script starts. */
  line: number;
  /** A short identifier to print on failure. */
  label: string;
}

/**
 * Extract <script>...</script> blocks that have NO `src` attribute.
 * Scripts with `src` (the CDN xterm.js + fit-addon) have empty bodies and
 * shouldn't be parsed.
 */
function extractInlineScripts(html: string, hostLabel: string): InlineScript[] {
  const blocks: InlineScript[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bsrc\s*=/.test(attrs)) continue;            // external script
    if (body.trim().length === 0) continue;           // empty inline
    const line = html.slice(0, m.index).split('\n').length;
    blocks.push({ source: body, line, label: `${hostLabel}@line${line}` });
  }
  return blocks;
}

function lint(html: string, hostLabel: string): string[] {
  const errors: string[] = [];
  const scripts = extractInlineScripts(html, hostLabel);
  if (scripts.length === 0) {
    errors.push(`${hostLabel}: no inline scripts found — guard regex out of date?`);
    return errors;
  }
  for (const s of scripts) {
    try {
      // `new Function` runs the JS parser without executing the body.
      // Globals like `document`, `window`, etc. are not resolved here —
      // we only care about parse-time syntax errors.
      new Function(s.source);
    } catch (err) {
      const msg = (err as Error).message;
      // Try to localize the failure within the script body.
      let snippet = '';
      const lineMatch = /line (\d+)/i.exec(msg);
      if (lineMatch) {
        const idx = Number(lineMatch[1]);
        const lines = s.source.split('\n');
        const around = lines.slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 2));
        snippet = `\n  excerpt:\n    ${around.join('\n    ')}`;
      }
      errors.push(`${s.label}: ${msg}${snippet}`);
    }
  }
  return errors;
}

const allErrors: string[] = [];
allErrors.push(...lint(WEB_CLIENT_HTML, 'web-client.ts'));
allErrors.push(...lint(LANDING_HTML, 'landing.ts'));

if (allErrors.length > 0) {
  console.error('check-html-scripts: inline JS failed to parse');
  for (const e of allErrors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

console.log('check-html-scripts: all inline scripts parse cleanly');
