import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

export async function which(command: string): Promise<string | null> {
  const paths = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.bat', '.exe'] : [''];

  for (const dir of paths) {
    for (const ext of extensions) {
      const full = join(dir, command + ext);
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {}
    }
  }
  return null;
}
