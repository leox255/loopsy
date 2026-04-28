#!/usr/bin/env node
/**
 * Sync the Loopsy relay Worker source into this package's `worker/` directory
 * so the published tarball is self-contained.
 *
 * Source of truth: ../relay/src/*.ts and ../relay/wrangler.toml.
 *
 * Output:
 *   worker/src/*.ts            (verbatim copy)
 *   worker/wrangler.template.toml  (placeholders for name/secret)
 *   worker/package.json        (minimal — wrangler reads it for type:module)
 *
 * Runs at build, dev, and prepack so the user always gets the latest worker
 * regardless of which entrypoint they hit.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const relaySrc = join(pkgRoot, '..', 'relay', 'src');
const relayPkgJson = join(pkgRoot, '..', 'relay', 'package.json');

const workerOut = join(pkgRoot, 'worker');
const workerSrcOut = join(workerOut, 'src');

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function main() {
  // Clean and recreate
  await fs.rm(workerOut, { recursive: true, force: true });
  await fs.mkdir(workerSrcOut, { recursive: true });

  // Copy worker TS source verbatim
  await copyDir(relaySrc, workerSrcOut);

  // Pull versions from the relay's own package.json so we stay in sync.
  const relayPkg = JSON.parse(await fs.readFile(relayPkgJson, 'utf8'));
  const workersTypesVersion = relayPkg.devDependencies?.['@cloudflare/workers-types'] ?? '^4.20250410.0';
  const wranglerVersion = relayPkg.devDependencies?.wrangler ?? '^4.67.0';

  // Minimal package.json so wrangler bundling resolves correctly.
  await fs.writeFile(
    join(workerOut, 'package.json'),
    JSON.stringify(
      {
        name: 'loopsy-relay-worker',
        version: '1.0.0',
        type: 'module',
        private: true,
        devDependencies: {
          '@cloudflare/workers-types': workersTypesVersion,
          wrangler: wranglerVersion,
        },
      },
      null,
      2,
    ) + '\n',
  );

  // Wrangler config template. `__WORKER_NAME__` is rendered by the CLI.
  // We don't ship `[observability]` because turning that on requires the
  // operator's account to have analytics enabled — keep it minimal here.
  const wranglerTemplate = `name = "__WORKER_NAME__"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

# Self-hosted deploys are app-only — '/' redirects to '/app' so the deploy
# has no marketing surface. The loopsy.dev relay leaves this unset and
# serves the landing page at '/'.
[vars]
HOMEPAGE_MODE = "app"

[[durable_objects.bindings]]
name = "DEVICE"
class_name = "DeviceObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DeviceObject"]

# Uncomment and edit to bind a custom domain (zone must already be on this
# Cloudflare account).
# [[routes]]
# pattern = "relay.example.com"
# custom_domain = true
`;
  await fs.writeFile(join(workerOut, 'wrangler.template.toml'), wranglerTemplate);

  // Minimal tsconfig so wrangler's TS bundler is happy.
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      lib: ['ES2022'],
      types: ['@cloudflare/workers-types'],
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  };
  await fs.writeFile(join(workerOut, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

  // .gitignore for the synced output (this dir is gitignored at the repo
  // root anyway, but having a local marker makes it obvious in tarball
  // listings).
  await fs.writeFile(join(workerOut, '.gitignore'), '# generated — sync via scripts/sync-worker.mjs\n');

  console.log(`[sync-worker] copied ${relaySrc} → ${workerSrcOut}`);
}

main().catch((err) => {
  console.error('[sync-worker] failed:', err);
  process.exit(1);
});
