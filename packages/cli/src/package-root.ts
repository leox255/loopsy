/**
 * Resolves paths to sibling packages (daemon, mcp-server, dashboard).
 *
 * Supports two layouts:
 *
 * 1. Monorepo (dev):
 *    packages/cli/dist/package-root.js  →  __dirname = packages/cli/dist/
 *    Sibling packages at: ../../daemon/dist/, ../../mcp-server/dist/, etc.
 *
 * 2. Flat npm package:
 *    dist/cli/package-root.js  →  __dirname = dist/cli/
 *    Sibling packages at: ../daemon/, ../mcp-server/, etc.
 *
 * Detection: check if ../../daemon/dist/main.js exists (monorepo) or
 * ../daemon/main.js exists (flat package).
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Detect layout by probing for daemon entry point
const monorepoCandidate = resolve(__dirname, '..', '..', 'daemon', 'dist', 'main.js');
const flatCandidate = resolve(__dirname, '..', 'daemon', 'main.js');

const isMonorepo = existsSync(monorepoCandidate);

/**
 * Root directory containing all package dist outputs.
 * - Monorepo: packages/  (so packages/daemon/dist/main.js works)
 * - Flat:     dist/      (so dist/daemon/main.js works)
 */
export const PACKAGES_ROOT = isMonorepo
  ? resolve(__dirname, '..', '..')   // packages/cli/dist/ → packages/
  : resolve(__dirname, '..');        // dist/cli/ → dist/

export function daemonMainPath(): string {
  return isMonorepo
    ? join(PACKAGES_ROOT, 'daemon', 'dist', 'main.js')
    : join(PACKAGES_ROOT, 'daemon', 'main.js');
}

export function mcpServerPath(): string {
  return isMonorepo
    ? join(PACKAGES_ROOT, 'mcp-server', 'dist', 'index.js')
    : join(PACKAGES_ROOT, 'mcp-server', 'index.js');
}

export function dashboardServerPath(): string {
  return isMonorepo
    ? join(PACKAGES_ROOT, 'dashboard', 'dist', 'server.js')
    : join(PACKAGES_ROOT, 'dashboard', 'server.js');
}

export function hookScriptPath(): string {
  return isMonorepo
    ? join(PACKAGES_ROOT, 'daemon', 'dist', 'hooks', 'permission-hook.mjs')
    : join(PACKAGES_ROOT, 'daemon', 'hooks', 'permission-hook.mjs');
}
