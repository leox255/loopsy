#!/usr/bin/env node
/**
 * Pre-build version sync.
 *
 * Mirrors the root package.json version into `PROTOCOL_VERSION` in
 * `packages/protocol/src/constants.ts`. Must run before `pnpm build` so
 * the compiled dist embeds the right value — `loopsy --version` and the
 * /health endpoint both read from `PROTOCOL_VERSION`.
 *
 * Used by the CI release workflow. Local dev can run it via `pnpm sync-version`
 * to refresh constants before a manual build.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const version = rootPkg.version;
if (!version) {
  console.error('[sync-version] root package.json has no version field');
  process.exit(1);
}

const constantsPath = join(ROOT, 'packages', 'protocol', 'src', 'constants.ts');
if (!existsSync(constantsPath)) {
  console.error(`[sync-version] missing ${constantsPath}`);
  process.exit(1);
}

const before = readFileSync(constantsPath, 'utf-8');
const after = before.replace(
  /export const PROTOCOL_VERSION = '[^']*';/,
  `export const PROTOCOL_VERSION = '${version}';`,
);
if (after === before) {
  console.log(`[sync-version] PROTOCOL_VERSION already at ${version}`);
} else {
  writeFileSync(constantsPath, after);
  console.log(`[sync-version] PROTOCOL_VERSION → ${version}`);
}
