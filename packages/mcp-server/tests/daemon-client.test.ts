import { describe, it, expect } from 'vitest';
import { DaemonClient } from '../src/daemon-client.js';

describe('DaemonClient', () => {
  it('creates with default config', () => {
    const client = new DaemonClient('test-key');
    expect(client).toBeDefined();
  });

  it('creates with custom port', () => {
    const client = new DaemonClient('test-key', 8080);
    expect(client).toBeDefined();
  });

  it('handles connection refused gracefully', async () => {
    const client = new DaemonClient('test-key', 19999);
    await expect(client.health()).rejects.toThrow();
  });
});
