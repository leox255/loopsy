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

// ─── Create postinstall script ────────────────────────────────────────
// This runs after `npm install` and creates @loopsy/* stubs in node_modules
// so that bare imports like `from '@loopsy/protocol'` resolve correctly.

mkdirSync(join(OUT, 'scripts'), { recursive: true });
writeFileSync(
  join(OUT, 'scripts', 'postinstall.mjs'),
  `#!/usr/bin/env node
/**
 * Postinstall: create @loopsy/* stub packages in node_modules so bare
 * specifier imports resolve to the bundled dist/ outputs.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const pkgRoot = resolve(dirname(__filename), '..');

// node_modules may be a sibling of the package (global install) or inside it
// For global installs: <prefix>/lib/node_modules/loopsy/node_modules/
// For local installs: <project>/node_modules/loopsy/node_modules/
const nodeModules = join(pkgRoot, 'node_modules');

const stubs = [
  { name: 'protocol', main: '../../dist/protocol/index.js' },
  { name: 'discovery', main: '../../dist/discovery/index.js' },
];

for (const stub of stubs) {
  const stubDir = join(nodeModules, '@loopsy', stub.name);

  // Don't overwrite if somehow already present (e.g. in monorepo dev)
  if (existsSync(join(stubDir, 'package.json'))) continue;

  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'package.json'),
    JSON.stringify({
      name: \`@loopsy/\${stub.name}\`,
      version: '${version}',
      type: 'module',
      main: stub.main,
      exports: { '.': { default: stub.main } },
    }, null, 2),
  );
}

console.log('loopsy: workspace stubs created');
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
    // Skip workspace deps (handled by postinstall stubs)
    if (typeof ver === 'string' && ver.startsWith('workspace:')) continue;
    // Take highest version if conflict
    if (!allDeps[name] || allDeps[name] < ver) {
      allDeps[name] = ver;
    }
  }
}

const packageJson = {
  name: 'loopsy',
  version,
  description:
    'Cross-machine communication for Claude Code — run commands, transfer files, and share context between machines',
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
  keywords: ['claude', 'claude-code', 'mcp', 'cross-machine', 'p2p', 'remote-execution'],
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
