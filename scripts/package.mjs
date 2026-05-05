#!/usr/bin/env node

/**
 * Loopsy Package Assembly Script
 *
 * Assembles all monorepo dist outputs into a flat layout suitable for
 * `npm publish`. The resulting `package-dist/` directory is a self-contained
 * npm package that can be installed globally.
 *
 * Layout:
 *   package-dist/
 *     package.json
 *     scripts/postinstall.mjs   ← creates @loopsy/* stubs in node_modules
 *     dist/
 *       cli/          ← entry point (bin)
 *       daemon/       ← main.js + hooks/
 *       mcp-server/   ← index.js
 *       dashboard/    ← server.js + public/
 *       protocol/     ← shared types & constants
 *       discovery/    ← mDNS peer discovery
 *
 * Usage:
 *   pnpm build && node scripts/package.mjs
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const OUT = join(ROOT, 'package-dist');

// Read version from root package.json
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const version = rootPkg.version || '1.0.0';

// PROTOCOL_VERSION is synced earlier via scripts/sync-version.mjs (which
// runs BEFORE pnpm build). Keep this script focused on dist assembly only —
// trying to write constants.ts here is a no-op for the artifact since the
// build already happened.

console.log(`Assembling loopsy v${version} into package-dist/...\n`);

// Clean output directory
if (existsSync(OUT)) {
  rmSync(OUT, { recursive: true });
}

// ─── Copy dist outputs ────────────────────────────────────────────────

const packages = ['protocol', 'discovery', 'daemon', 'mcp-server', 'cli', 'dashboard'];

for (const pkg of packages) {
  const src = join(ROOT, 'packages', pkg, 'dist');
  const dest = join(OUT, 'dist', pkg);

  if (!existsSync(src)) {
    console.error(`ERROR: ${src} does not exist. Run "pnpm build" first.`);
    process.exit(1);
  }

  console.log(`  ${pkg}/dist/ → dist/${pkg}/`);
  cpSync(src, dest, { recursive: true });
}

// ─── Copy dashboard public assets ─────────────────────────────────────

const dashboardPublic = join(ROOT, 'packages', 'dashboard', 'public');
if (existsSync(dashboardPublic)) {
  console.log('  dashboard/public/ → dist/dashboard/public/');
  cpSync(dashboardPublic, join(OUT, 'dist', 'dashboard', 'public'), { recursive: true });
}

// ─── Copy daemon hooks (permission-hook.mjs) ──────────────────────────

const hooksSrc = join(ROOT, 'packages', 'daemon', 'dist', 'hooks');
const hooksDest = join(OUT, 'dist', 'daemon', 'hooks');
if (existsSync(hooksSrc)) {
  console.log('  daemon/dist/hooks/ → dist/daemon/hooks/');
  cpSync(hooksSrc, hooksDest, { recursive: true });
}

// ─── Copy README and LICENSE ──────────────────────────────────────────

for (const file of ['README.md', 'LICENSE']) {
  const src = join(ROOT, file);
  if (existsSync(src)) {
    cpSync(src, join(OUT, file));
    console.log(`  ${file}`);
  }
}

// ─── Pre-bundle @loopsy/* workspace stubs ─────────────────────────────
// Ship the workspace packages inside the published tarball under
// node_modules/@loopsy/*. Combined with bundleDependencies in the
// generated package.json (added below), this means bare imports like
// `from '@loopsy/protocol'` resolve immediately after `npm install`
// extracts the tarball — without needing a postinstall script to run.
//
// Postinstall used to create these stubs, but that breaks for users
// who install with `--ignore-scripts` (a common security default and
// the npx fallback path), causing ERR_MODULE_NOT_FOUND on first run.

const stubs = [
  { name: 'protocol', distDir: 'protocol' },
  { name: 'discovery', distDir: 'discovery' },
];

for (const stub of stubs) {
  const stubDir = join(OUT, 'node_modules', '@loopsy', stub.name);
  const srcDir = join(OUT, 'dist', stub.distDir);
  cpSync(srcDir, stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'package.json'),
    JSON.stringify({
      name: `@loopsy/${stub.name}`,
      version,
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js' },
    }, null, 2),
  );
  console.log(`  bundled node_modules/@loopsy/${stub.name}/`);
}

// ─── Create postinstall script ────────────────────────────────────────
// Postinstall does two things:
//   1. Belt-and-suspenders stub creation — bundleDependencies covers npm
//      and pnpm, but Yarn 1 ignores it (yarnpkg/yarn#993). When Yarn 1
//      installs without --ignore-scripts, this rebuilds the stubs from
//      the bundled dist/ so the CLI loads. Already-present stubs are
//      left alone (no-op for npm/pnpm where bundleDependencies already
//      placed them).
//   2. First-run `loopsy init` if no config exists.

mkdirSync(join(OUT, 'scripts'), { recursive: true });
writeFileSync(
  join(OUT, 'scripts', 'postinstall.mjs'),
  `#!/usr/bin/env node
/**
 * Postinstall responsibilities:
 *
 *   1. Yarn-1 fallback: rebuild @loopsy/* stubs in node_modules. npm and
 *      pnpm respect bundleDependencies and have already placed them; this
 *      is a no-op there. Yarn 1 strips bundled deps on install
 *      (yarnpkg/yarn#993) and would otherwise crash on bare imports.
 *      Users on \`--ignore-scripts\` will get a working CLI from the
 *      bundleDependencies path; this fallback is only for the Yarn-1
 *      / scripts-allowed case.
 *
 *   2. First-time \`loopsy init\` if no config exists yet.
 */
import { mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const pkgRoot = resolve(dirname(__filename), '..');
const nodeModules = join(pkgRoot, 'node_modules');

// 1. Stub fallback for Yarn-1-style installs that strip bundleDependencies.
const stubs = ${JSON.stringify(stubs)};
for (const stub of stubs) {
  const stubDir = join(nodeModules, '@loopsy', stub.name);
  if (existsSync(join(stubDir, 'package.json'))) continue; // bundleDependencies already placed it
  const srcDir = join(pkgRoot, 'dist', stub.distDir);
  if (!existsSync(srcDir)) continue; // shouldn't happen — published tarball always has dist/
  mkdirSync(stubDir, { recursive: true });
  cpSync(srcDir, stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'package.json'),
    JSON.stringify({
      name: \`@loopsy/\${stub.name}\`,
      version: '${version}',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js' },
    }, null, 2),
  );
  console.log(\`loopsy: rebuilt @loopsy/\${stub.name} stub (Yarn 1 fallback)\`);
}

// 2. First-run init.
const configPath = join(homedir(), '.loopsy', 'config.yaml');
if (!existsSync(configPath)) {
  console.log('loopsy: first-time setup — running loopsy init...');
  try {
    const cliPath = join(pkgRoot, 'dist', 'cli', 'index.js');
    execSync(\`node \${cliPath} init\`, { stdio: 'inherit' });
  } catch (err) {
    console.log('loopsy: auto-init failed (run "loopsy init" manually)');
  }
}
`,
);
console.log('  Created scripts/postinstall.mjs');

// ─── Generate package.json ────────────────────────────────────────────
// Merge external (non-workspace) dependencies from all packages.

const allDeps = {};

for (const pkg of packages) {
  const pkgJsonPath = join(ROOT, 'packages', pkg, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const deps = pkgJson.dependencies || {};

  for (const [name, ver] of Object.entries(deps)) {
    // Skip workspace deps — they're shipped as bundled stubs (see the
    // bundleDependencies block below), not declared as registry deps.
    if (typeof ver === 'string' && ver.startsWith('workspace:')) continue;
    // Take highest version if conflict
    if (!allDeps[name] || allDeps[name] < ver) {
      allDeps[name] = ver;
    }
  }
}

// Declare bundled @loopsy/* packages alongside external deps. npm pack
// includes anything listed in bundleDependencies from node_modules/ even
// when `files` would otherwise exclude it, and resolves them locally
// instead of fetching from the registry on install — so they survive
// `--ignore-scripts` installs and offline npx runs.
const bundleDependencies = stubs.map((s) => `@loopsy/${s.name}`);
for (const name of bundleDependencies) {
  allDeps[name] = version;
}

const packageJson = {
  name: 'loopsy',
  version,
  description:
    'Cross-machine communication for AI coding agents — run commands, transfer files, and share context between machines',
  type: 'module',
  bin: {
    loopsy: 'dist/cli/index.js',
  },
  files: ['dist/', 'scripts/'],
  engines: {
    node: '>=20',
  },
  scripts: {
    postinstall: 'node scripts/postinstall.mjs',
  },
  dependencies: allDeps,
  bundleDependencies,
  keywords: ['claude', 'claude-code', 'gemini', 'codex', 'mcp', 'cross-machine', 'p2p', 'remote-execution', 'ai-agents'],
  license: 'Apache-2.0',
  repository: {
    type: 'git',
    url: 'git+https://github.com/leox255/loopsy.git',
  },
};

writeFileSync(join(OUT, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
console.log('\n  Generated package.json');

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\nDone! Package assembled at: ${OUT}`);
console.log(`\nExternal dependencies (${Object.keys(allDeps).length}):`);
for (const [name, ver] of Object.entries(allDeps)) {
  console.log(`  ${name}: ${ver}`);
}
console.log('\nNext steps:');
console.log('  cd package-dist && npm pack');
console.log('  npm install -g ./loopsy-*.tgz');
console.log('  loopsy init && loopsy start && loopsy status');
