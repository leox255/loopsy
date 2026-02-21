import { describe, it, expect } from 'vitest';
import { ExecuteParamsSchema, ContextSetSchema, HandshakeSchema } from '../src/schemas.js';

describe('ExecuteParamsSchema', () => {
  it('validates a valid execute request', () => {
    const result = ExecuteParamsSchema.parse({
      command: 'ls',
      args: ['-la'],
    });
    expect(result.command).toBe('ls');
    expect(result.args).toEqual(['-la']);
    expect(result.stream).toBe(false);
  });

  it('rejects empty command', () => {
    expect(() => ExecuteParamsSchema.parse({ command: '' })).toThrow();
  });

  it('applies defaults', () => {
    const result = ExecuteParamsSchema.parse({ command: 'echo' });
    expect(result.args).toEqual([]);
    expect(result.stream).toBe(false);
  });
});

describe('ContextSetSchema', () => {
  it('validates a context set request', () => {
    const result = ContextSetSchema.parse({ value: 'hello world' });
    expect(result.value).toBe('hello world');
  });

  it('accepts optional ttl', () => {
    const result = ContextSetSchema.parse({ value: 'test', ttl: 3600 });
    expect(result.ttl).toBe(3600);
  });

  it('rejects negative ttl', () => {
    expect(() => ContextSetSchema.parse({ value: 'test', ttl: -1 })).toThrow();
  });
});

describe('HandshakeSchema', () => {
  it('validates a handshake', () => {
    const result = HandshakeSchema.parse({
      nodeId: 'test-node',
      hostname: 'my-mac',
      platform: 'darwin',
      version: '1.0.0',
      port: 19532,
      capabilities: ['execute', 'transfer'],
    });
    expect(result.nodeId).toBe('test-node');
    expect(result.capabilities).toHaveLength(2);
  });

  it('rejects invalid port', () => {
    expect(() =>
      HandshakeSchema.parse({
        nodeId: 'test',
        hostname: 'test',
        platform: 'test',
        version: '1.0.0',
        port: 99999,
        capabilities: [],
      }),
    ).toThrow();
  });
});
