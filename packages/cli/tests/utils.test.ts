import { describe, it, expect } from 'vitest';
import { parsePeerAddress } from '../src/utils.js';

describe('parsePeerAddress', () => {
  it('parses host:port', () => {
    const result = parsePeerAddress('192.168.1.100:19532');
    expect(result.address).toBe('192.168.1.100');
    expect(result.port).toBe(19532);
  });

  it('defaults port to 19532', () => {
    const result = parsePeerAddress('192.168.1.100');
    expect(result.address).toBe('192.168.1.100');
    expect(result.port).toBe(19532);
  });

  it('handles custom port', () => {
    const result = parsePeerAddress('10.0.0.1:8080');
    expect(result.address).toBe('10.0.0.1');
    expect(result.port).toBe(8080);
  });
});
