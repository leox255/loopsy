import { daemonRequest } from '../utils.js';

export async function contextCommand(argv: any) {
  const sub = argv._[1];

  try {
    if (sub === 'set') {
      const result = await daemonRequest(`/context/${encodeURIComponent(argv.key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: argv.value, ttl: argv.ttl }),
      });
      console.log('Context set:', JSON.stringify(result, null, 2));
    } else if (sub === 'get') {
      const result = await daemonRequest(`/context/${encodeURIComponent(argv.key)}`);
      console.log(result.value);
    } else if (sub === 'delete') {
      await daemonRequest(`/context/${encodeURIComponent(argv.key)}`, { method: 'DELETE' });
      console.log(`Deleted key: ${argv.key}`);
    } else {
      // list
      const result = await daemonRequest('/context');
      if (result.entries.length === 0) {
        console.log('No context entries');
      } else {
        for (const entry of result.entries) {
          const ttl = entry.expiresAt ? ` (expires in ${Math.round((entry.expiresAt - Date.now()) / 1000)}s)` : '';
          console.log(`  ${entry.key} = ${entry.value.slice(0, 80)}${entry.value.length > 80 ? '...' : ''}${ttl}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
