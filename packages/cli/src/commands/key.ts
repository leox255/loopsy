import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';

const CONFIG_PATH = join(homedir(), CONFIG_DIR, CONFIG_FILE);

export async function keyCommand(argv: any) {
  const sub = argv._[1];

  if (sub === 'generate') {
    const newKey = randomBytes(32).toString('hex');
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      const config = parseYaml(raw) as any;
      config.auth = config.auth ?? {};
      config.auth.apiKey = newKey;
      await writeFile(CONFIG_PATH, toYaml(config));
      console.log(`New API key generated: ${newKey}`);
      console.log('Restart the daemon for the new key to take effect.');
    } catch {
      console.error('Config not found. Run "loopsy init" first.');
    }
  } else if (sub === 'show') {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      const config = parseYaml(raw) as any;
      console.log(config.auth?.apiKey ?? 'No API key configured');
    } catch {
      console.error('Config not found. Run "loopsy init" first.');
    }
  } else {
    console.log('Usage: loopsy key <generate|show>');
  }
}
