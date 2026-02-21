import { describe, it, expect, beforeEach } from 'vitest';
import { ContextStore } from '../src/services/context-store.js';
import { LoopsyError } from '@loopsy/protocol';

describe('ContextStore', () => {
  let store: ContextStore;

  beforeEach(() => {
    store = new ContextStore();
  });

  it('sets and gets a value', () => {
    store.set('greeting', 'hello', 'node-1');
    const entry = store.get('greeting');
    expect(entry?.value).toBe('hello');
    expect(entry?.fromNodeId).toBe('node-1');
  });

  it('updates existing value', () => {
    store.set('key', 'v1', 'node-1');
    store.set('key', 'v2', 'node-2');
    const entry = store.get('key');
    expect(entry?.value).toBe('v2');
    expect(entry?.fromNodeId).toBe('node-2');
  });

  it('deletes a value', () => {
    store.set('key', 'val', 'node-1');
    expect(store.delete('key')).toBe(true);
    expect(store.get('key')).toBeUndefined();
  });

  it('lists all values', () => {
    store.set('a', '1', 'node-1');
    store.set('b', '2', 'node-1');
    expect(store.list()).toHaveLength(2);
  });

  it('respects TTL expiry', async () => {
    store.set('temp', 'value', 'node-1', 0.001); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get('temp')).toBeUndefined();
  });

  it('tracks size', () => {
    expect(store.size).toBe(0);
    store.set('a', '1', 'node-1');
    expect(store.size).toBe(1);
  });

  it('throws on value too large', () => {
    const huge = 'x'.repeat(1_048_577);
    expect(() => store.set('big', huge, 'node-1')).toThrow(LoopsyError);
  });
});
