import { daemonRequest } from '../utils.js';

export async function peersCommand(argv: any) {
  const sub = argv._[1];

  if (sub === 'add') {
    const result = await daemonRequest('/peers', {
      method: 'POST',
      body: JSON.stringify({ address: argv.address, port: argv.port ?? 19532 }),
    });
    console.log('Peer added:', JSON.stringify(result, null, 2));
  } else if (sub === 'remove') {
    const result = await daemonRequest(`/peers/${encodeURIComponent(argv.nodeId)}`, { method: 'DELETE' });
    console.log('Peer removed:', JSON.stringify(result, null, 2));
  } else {
    // List peers
    const result = await daemonRequest('/peers');
    if (result.peers.length === 0) {
      console.log('No peers found');
    } else {
      for (const peer of result.peers) {
        const status = peer.status === 'online' ? '\x1b[32monline\x1b[0m' : '\x1b[31moffline\x1b[0m';
        console.log(`  ${peer.nodeId.slice(0, 8)}  ${peer.address}:${peer.port}  ${peer.hostname}  ${status}`);
      }
    }
  }
}
