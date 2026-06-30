import { createRequire } from 'node:module';
import { chmodSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * node-pty 1.1.0 publishes its macOS/Linux `spawn-helper` prebuilt binary
 * WITHOUT the execute bit (mode 0644 in the tarball). node-pty execs that
 * helper via posix_spawnp for every PTY it opens, so without +x every spawn
 * dies with `Error: posix_spawnp failed.` — which silently breaks the daemon,
 * since it runs every shell / Claude / Gemini / Codex session through node-pty.
 *
 * We cannot rely on install-time fixes: node-pty's own scripts only touch the
 * from-source `build/Release` path (never the prebuild), and npm 11.17+ blocks
 * postinstall scripts by default (`allow-scripts`), as does `--ignore-scripts`.
 * So restore the bit here, at daemon startup, before any PTY is opened.
 * Idempotent and best-effort.
 */
export function ensurePtyHelperExecutable(): void {
  if (process.platform === 'win32') return; // Windows uses conpty — no spawn-helper.
  try {
    const require = createRequire(import.meta.url);
    const ptyRoot = dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of candidates) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if (mode & 0o100) continue; // owner already has execute — nothing to do.
      chmodSync(helper, mode | 0o755);
    }
  } catch {
    // Best-effort: if node-pty can't be resolved or chmod fails, let the real
    // spawn surface its own error rather than masking it here.
  }
}
