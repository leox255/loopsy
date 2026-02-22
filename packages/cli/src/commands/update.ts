import { execSync } from 'node:child_process';

export async function updateCommand() {
  console.log('Checking for updates...');

  try {
    const latest = execSync('npm view loopsy version', { encoding: 'utf-8' }).trim();
    const current = execSync('npm ls -g loopsy --depth=0 --json 2>/dev/null', { encoding: 'utf-8' });
    let installed = 'unknown';
    try {
      const parsed = JSON.parse(current);
      installed = parsed.dependencies?.loopsy?.version || 'unknown';
    } catch {}

    console.log(`  Installed: ${installed}`);
    console.log(`  Latest:    ${latest}`);

    if (installed === latest) {
      console.log('\nAlready up to date.');
      return;
    }

    console.log(`\nUpdating to ${latest}...`);
    execSync('npm install -g loopsy@latest', { stdio: 'inherit' });
    console.log('\nUpdate complete. Run "loopsy restart" to pick up the new version.');
  } catch (err: any) {
    console.error(`Update failed: ${err.message}`);
    console.error('You can update manually with: npm install -g loopsy@latest');
  }
}
