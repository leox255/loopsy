#!/usr/bin/env node
/**
 * @loopsy/deploy-relay — one-command Cloudflare Workers deploy for the Loopsy
 * relay. Targets self-hosters who want to run their own relay on the free
 * tier without cloning the repo.
 *
 * Flow:
 *   1. Prompt for worker name (default: loopsy-relay-<random>) and optional
 *      custom domain.
 *   2. Generate a 32-byte PAIR_TOKEN_SECRET.
 *   3. Stage the bundled worker source into a temp dir.
 *   4. Render wrangler.toml from the template.
 *   5. `wrangler deploy` — wrangler handles auth (opens browser if needed).
 *   6. `wrangler secret put PAIR_TOKEN_SECRET` — piped via stdin so the secret
 *      never lands on the user's clipboard or in process args.
 *   7. Save config to ~/.loopsy/relay.json so the daemon can find it.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ────────────────────────────────────────────────────────────────────────────
// ANSI helpers (no chalk dep — keep the package light)
// ────────────────────────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};
const supportsColor = process.stdout.isTTY && process.env.TERM !== 'dumb' && !process.env.NO_COLOR;
const c = (code: string, s: string) => (supportsColor ? `${code}${s}${ANSI.reset}` : s);
const dim = (s: string) => c(ANSI.dim, s);
const bold = (s: string) => c(ANSI.bold, s);
const green = (s: string) => c(ANSI.green, s);
const red = (s: string) => c(ANSI.red, s);
const yellow = (s: string) => c(ANSI.yellow, s);
const blue = (s: string) => c(ANSI.blue, s);
const cyan = (s: string) => c(ANSI.cyan, s);

// ────────────────────────────────────────────────────────────────────────────
// Args
// ────────────────────────────────────────────────────────────────────────────

interface Args {
  workerName?: string;
  domain?: string;
  yes: boolean;
  help: boolean;
  /** Force creating a new deploy even if ~/.loopsy/relay.json exists. */
  fresh: boolean;
  /** Re-roll PAIR_TOKEN_SECRET on update (default: keep existing). */
  rotateSecret: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { yes: false, help: false, fresh: false, rotateSecret: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--version' || v === '-V') a.version = true;
    else if (v === '--yes' || v === '-y' || v === '--no-interactive') a.yes = true;
    else if (v === '--worker-name' || v === '--name') a.workerName = argv[++i];
    else if (v === '--domain') a.domain = argv[++i];
    else if (v === '--fresh' || v === '--new') a.fresh = true;
    else if (v === '--rotate-secret') a.rotateSecret = true;
    else if (v.startsWith('--worker-name=')) a.workerName = v.split('=', 2)[1];
    else if (v.startsWith('--domain=')) a.domain = v.split('=', 2)[1];
  }
  return a;
}

function printHelp() {
  console.log(`
${bold('@loopsy/deploy-relay')} — deploy a Loopsy relay to your Cloudflare Workers account.

${bold('Usage:')}
  npx @loopsy/deploy-relay [options]

${bold('Options:')}
  --worker-name <name>   Worker name (default: loopsy-relay-<random>, or
                         existing name from ~/.loopsy/relay.json if present)
  --domain <fqdn>        Bind a custom domain (zone must be on your CF account)
  --fresh, --new         Ignore ~/.loopsy/relay.json and create a brand-new
                         deploy with a random worker name
  --rotate-secret        On update, also re-roll PAIR_TOKEN_SECRET (default:
                         preserve so in-flight pair tokens stay valid)
  --yes, -y              Non-interactive — accept defaults
  --version, -V          Print version and exit
  --help, -h             Show this help

${bold('Example:')}
  ${dim('# Interactive — recommended for first-time setup')}
  npx @loopsy/deploy-relay

  ${dim('# Scripted')}
  npx @loopsy/deploy-relay --worker-name my-relay --domain relay.example.com -y

${dim('Free tier on Cloudflare Workers covers personal use. ~30 seconds.')}
`);
}

// ────────────────────────────────────────────────────────────────────────────
// Filesystem helpers
// ────────────────────────────────────────────────────────────────────────────

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

function findWorkerSourceDir(): string {
  // dist/cli.js → ../worker (when published)
  // src/cli.ts  → ../worker (when developing via tsx, after sync-worker ran)
  const here = dirname(fileURLToPath(import.meta.url));
  // Try ../worker (matches both layouts)
  return join(here, '..', 'worker');
}

function findWranglerBin(): string {
  const require = createRequire(import.meta.url);
  const wranglerPkgPath = require.resolve('wrangler/package.json');
  const wranglerDir = dirname(wranglerPkgPath);
  const pkg = JSON.parse(readFileSync(wranglerPkgPath, 'utf8'));
  const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;
  if (!binEntry) throw new Error('wrangler package has no bin entry — corrupt install?');
  return join(wranglerDir, binEntry);
}

// ────────────────────────────────────────────────────────────────────────────
// Subprocess — wrangler
// ────────────────────────────────────────────────────────────────────────────

interface SpawnOpts {
  cwd: string;
  stdin?: string;          // when set, piped to wrangler's stdin
  captureStdout?: boolean; // when set, returns stdout instead of streaming
  /**
   * When false, wrangler's stdout/stderr is captured rather than streamed.
   * Used for `secret put` where we don't want the secret-set echoed.
   */
  inherit?: boolean;
}

interface SpawnResult { code: number; stdout: string; stderr: string }

function runWrangler(args: string[], opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const wranglerBin = findWranglerBin();
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: supportsColor ? '1' : '0' },
      stdio: [
        opts.stdin !== undefined ? 'pipe' : 'inherit',
        opts.inherit === false || opts.captureStdout ? 'pipe' : 'inherit',
        opts.inherit === false ? 'pipe' : 'inherit',
      ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Prompts
// ────────────────────────────────────────────────────────────────────────────

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  const suffix = defaultValue ? dim(` [${defaultValue}]`) : '';
  try {
    const answer = (await rl.question(`${cyan('?')} ${question}${suffix} `)).trim();
    return answer || (defaultValue ?? '');
  } finally {
    rl.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function generateWorkerSuffix(): string {
  return randomBytes(2).toString('hex'); // 4 hex chars
}

function validateWorkerName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(name)) {
    return 'Worker names must be lowercase a-z, 0-9, hyphens (3–63 chars), no leading/trailing hyphen.';
  }
  return null;
}

function validateDomain(d: string): string | null {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d)) {
    return 'Expected a fully-qualified domain (e.g. relay.example.com).';
  }
  return null;
}

async function loopsyConfigPath(): Promise<string> {
  const dir = join(homedir(), '.loopsy');
  await fs.mkdir(dir, { recursive: true });
  return join(dir, 'relay.json');
}

interface SavedConfig {
  url: string;
  worker_name: string;
  domain?: string;
  deployed_at: string;
}

function extractDeployedUrl(stdout: string, fallback: string): string {
  // Wrangler 4.x prints a line like:
  //   Deployed loopsy-relay-7f3a triggers (… sec)
  //     https://loopsy-relay-7f3a.user.workers.dev
  const m = stdout.match(/https?:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  if (m) return m[0];
  // Fallback to the known custom domain if user supplied one.
  return fallback;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js → ../package.json   (also works from src/cli.ts via tsx)
    const pkgPath = join(here, '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Daemon config (~/.loopsy/config.yaml) — read/write the `relay:` block so
// that a fresh deploy can offer to point the laptop's daemon at itself.
// Without this, ~/.loopsy/relay.json is purely informational and the daemon
// keeps using whatever URL was previously configured.
// ────────────────────────────────────────────────────────────────────────────

interface DaemonRelayBlock {
  url: string;
  deviceId: string;
  deviceSecret: string;
}

interface DaemonConfig {
  relay?: DaemonRelayBlock;
  [key: string]: unknown;
}

function daemonConfigPath(): string {
  return join(homedir(), '.loopsy', 'config.yaml');
}

async function readDaemonConfig(): Promise<DaemonConfig | null> {
  try {
    const raw = await fs.readFile(daemonConfigPath(), 'utf8');
    const parsed = parseYaml(raw);
    return (parsed && typeof parsed === 'object') ? (parsed as DaemonConfig) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeDaemonConfig(config: DaemonConfig): Promise<void> {
  await fs.writeFile(daemonConfigPath(), stringifyYaml(config), { mode: 0o600 });
}

interface RegisterResponse {
  device_id: string;
  device_secret: string;
  relay_url: string;
}

async function registerDevice(relayUrl: string): Promise<DaemonRelayBlock> {
  const res = await fetch(`${relayUrl}/device/register`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Relay rejected /device/register: ${res.status} ${body}`);
  }
  const data = (await res.json()) as RegisterResponse;
  return {
    url: data.relay_url,
    deviceId: data.device_id,
    deviceSecret: data.device_secret,
  };
}

/**
 * After a successful deploy, offer to repoint the laptop's daemon at the
 * new relay. Returns true if the daemon was reconfigured (and the caller
 * should skip the manual `loopsy relay configure` next-step instruction).
 */
async function maybeSwitchDaemon(args: Args, deployedUrl: string): Promise<boolean> {
  const cfg = await readDaemonConfig();
  if (cfg === null) {
    // No daemon installed yet on this machine. Nothing to switch — fall
    // through to the printed `loopsy relay configure` instruction.
    return false;
  }

  const currentUrl = cfg.relay?.url?.replace(/\/$/, '') ?? '';
  const targetUrl = deployedUrl.replace(/\/$/, '');

  if (currentUrl === targetUrl) {
    console.log(dim(`→ Daemon is already pointed at this relay — nothing to switch.`));
    return true;
  }

  console.log();
  if (currentUrl) {
    console.log(`${yellow('!')} Your daemon is currently pointed at ${dim(currentUrl)}`);
    console.log(dim(`  Switching wipes the existing device_id — paired phones must be re-paired.`));
  } else {
    console.log(dim(`→ Your daemon has no relay configured yet.`));
  }

  let yes = args.yes;
  if (!yes) {
    const ans = await prompt(`Point the daemon at ${cyan(targetUrl)} now? ${dim('[Y/n]')}`, 'Y');
    yes = !/^n(o)?$/i.test(ans.trim());
  }
  if (!yes) {
    console.log(dim(`  Skipping. Run "loopsy relay configure ${targetUrl}" later to switch.`));
    return false;
  }

  console.log(`${dim('→')} Registering this laptop with ${cyan(targetUrl)}`);
  let block: DaemonRelayBlock;
  try {
    block = await registerDevice(targetUrl);
  } catch (err) {
    console.error(red(`✗ Could not register: ${(err as Error).message}`));
    console.log(dim(`  Run "loopsy relay configure ${targetUrl}" manually once the relay is reachable.`));
    return false;
  }

  cfg.relay = { ...(cfg.relay ?? {}), ...block };
  await writeDaemonConfig(cfg);
  console.log(`${green('✓')} Updated ${dim('~/.loopsy/config.yaml')} (device_id ${block.deviceId})`);
  console.log(yellow('  ⚠ ') + `Restart the daemon: ${cyan('loopsy stop && loopsy start')}`);
  return true;
}

async function readSavedConfig(): Promise<SavedConfig | null> {
  try {
    const cfgPath = await loopsyConfigPath();
    const raw = await fs.readFile(cfgPath, 'utf8');
    const cfg = JSON.parse(raw) as SavedConfig;
    if (cfg && typeof cfg.url === 'string' && typeof cfg.worker_name === 'string') return cfg;
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  const version = readPackageVersion();
  if (args.version) { console.log(version); return; }

  // Banner
  console.log();
  console.log(bold(`  ${blue('Loopsy')} relay deploy`) + dim(`  v${version}`));
  console.log(dim(`  Cloudflare Workers free tier · ~30 seconds`));
  console.log();

  // Detect prior deploy from ~/.loopsy/relay.json so a re-run updates the
  // existing worker instead of silently creating a new one alongside it.
  const prior = args.fresh ? null : await readSavedConfig();
  const isUpdate = prior !== null && !args.workerName && !args.domain;
  if (prior && !args.fresh) {
    console.log(`${dim('→')} Found existing deploy at ${cyan(prior.url)} ${dim(`(${prior.worker_name})`)}`);
    console.log(dim(`  Re-running with the same name updates it. Use --fresh for a new deploy.`));
    console.log();
  }

  // Resolve inputs. Prior deploy seeds defaults so the no-arg re-run path
  // reliably hits "update" rather than "create new with random suffix".
  let workerName = args.workerName ?? prior?.worker_name ?? `loopsy-relay-${generateWorkerSuffix()}`;
  let domain = args.domain ?? prior?.domain;

  if (!args.yes) {
    workerName = await prompt('Worker name', workerName);
    if (!domain) {
      const d = await prompt(`Custom domain ${dim('(optional, e.g. relay.example.com)')}`, '');
      if (d) domain = d;
    }
  }

  // Validate
  const wnErr = validateWorkerName(workerName);
  if (wnErr) { console.error(red(`✗ ${wnErr}`)); process.exit(1); }
  if (domain) {
    const dErr = validateDomain(domain);
    if (dErr) { console.error(red(`✗ ${dErr}`)); process.exit(1); }
  }

  // Stage temp dir from bundled worker source
  const workerSrc = findWorkerSourceDir();
  try { await fs.access(join(workerSrc, 'src', 'index.ts')); }
  catch {
    console.error(red('✗ Could not locate bundled worker source.'));
    console.error(red(`  Looked at ${workerSrc}/src/index.ts`));
    console.error(dim('  If you are running from a dev checkout, run `pnpm --filter @loopsy/deploy-relay run build` first.'));
    process.exit(1);
  }

  const tmp = await fs.mkdtemp(join(tmpdir(), 'loopsy-deploy-'));
  await copyDir(workerSrc, tmp);

  // Render wrangler.toml
  const templatePath = join(tmp, 'wrangler.template.toml');
  let wranglerToml = await fs.readFile(templatePath, 'utf8');
  wranglerToml = wranglerToml.replace(/__WORKER_NAME__/g, workerName);
  if (domain) {
    wranglerToml += `\n[[routes]]\npattern = "${domain}"\ncustom_domain = true\n`;
  }
  await fs.writeFile(join(tmp, 'wrangler.toml'), wranglerToml);
  await fs.unlink(templatePath);

  console.log(`${dim('→')} Staged worker source to ${dim(tmp)}`);
  if (domain) console.log(`${dim('→')} Custom domain: ${cyan(domain)} ${dim('(zone must be on your Cloudflare account)')}`);

  // Deploy
  console.log(`${dim('→')} Running ${cyan('wrangler deploy')} ${dim('(may open browser for auth)')}`);
  console.log();
  const deployRes = await runWrangler(['deploy'], { cwd: tmp, captureStdout: true });
  if (deployRes.code !== 0) {
    console.error();
    console.error(red('✗ wrangler deploy failed.'));
    if (deployRes.stderr) console.error(deployRes.stderr);
    process.exit(deployRes.code);
  }
  // Echo wrangler's stdout (we captured it so we could parse the URL).
  process.stdout.write(deployRes.stdout);

  const deployedUrl = domain
    ? `https://${domain}`
    : extractDeployedUrl(deployRes.stdout, `https://${workerName}.workers.dev`);
  console.log(`${green('✓')} ${isUpdate ? 'Updated' : 'Deployed'}: ${cyan(deployedUrl)}`);

  // Set PAIR_TOKEN_SECRET via wrangler secret put (piped via stdin so it
  // never appears on the user's clipboard or in process arguments). On
  // re-runs against an existing deploy we preserve the existing secret so
  // any in-flight pair tokens stay valid; pass --rotate-secret to opt in.
  const skipSecret = isUpdate && !args.rotateSecret;
  if (skipSecret) {
    console.log(dim(`→ Keeping existing PAIR_TOKEN_SECRET (pass --rotate-secret to re-roll)`));
  } else {
    const secret = generateSecret();
    console.log(`${dim('→')} Setting ${cyan('PAIR_TOKEN_SECRET')}`);
    const secretRes = await runWrangler(['secret', 'put', 'PAIR_TOKEN_SECRET'], {
      cwd: tmp,
      stdin: secret + '\n',
      inherit: false,
    });
    if (secretRes.code !== 0) {
      console.error(red('✗ Failed to set PAIR_TOKEN_SECRET.'));
      if (secretRes.stderr) console.error(secretRes.stderr);
      process.exit(secretRes.code);
    }
    console.log(`${green('✓')} Secret set`);
  }

  // Save config
  const cfgPath = await loopsyConfigPath();
  const cfg: SavedConfig = {
    url: deployedUrl,
    worker_name: workerName,
    deployed_at: new Date().toISOString(),
  };
  if (domain) cfg.domain = domain;
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  console.log(`${green('✓')} Saved config to ${dim(cfgPath)}`);

  // Best-effort cleanup of staging dir
  try { await fs.rm(tmp, { recursive: true, force: true }); } catch {/* ignore */}

  // Offer to repoint the laptop's daemon at this relay. Without this,
  // ~/.loopsy/config.yaml keeps using the old URL and `loopsy mobile pair`
  // emits pair links for the wrong relay.
  const daemonSwitched = await maybeSwitchDaemon(args, deployedUrl);

  // Next steps
  console.log();
  console.log(bold('  Next steps'));
  let stepIdx = 1;
  if (!daemonSwitched) {
    console.log(`  ${dim(stepIdx + '.')} Configure your laptop daemon:`);
    console.log(`     ${cyan(`loopsy relay configure ${deployedUrl}`)}`);
    stepIdx++;
  }
  console.log(`  ${dim(stepIdx + '.')} Pair your phone:`);
  console.log(`     ${cyan('loopsy mobile pair --ttl 600')}`);
  console.log();
  console.log(dim(`  Open ${deployedUrl}/app on your phone after pairing.`));
  console.log();
  if (domain) {
    console.log(yellow('  ⚠ ') + `Custom domain bound. If DNS isn't propagated yet, the workers.dev URL still works.`);
    console.log();
  }
}

main().catch((err) => {
  console.error();
  console.error(red('✗ Unexpected error:'));
  console.error(err?.stack ?? err);
  process.exit(1);
});
