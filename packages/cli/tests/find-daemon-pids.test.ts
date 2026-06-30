import { describe, it, expect } from 'vitest';
import {
  parsePidsFromNetstat,
  parsePidsFromLsof,
  parsePidsFromSs,
} from '../src/find-daemon-pids.js';

describe('parsePidsFromNetstat', () => {
  // Real output captured from the stuck Windows daemon (DESKTOP-PVTH8R3).
  const windowsOutput = [
    '  TCP    0.0.0.0:19532          0.0.0.0:0              LISTENING       10440',
    '  TCP    192.168.1.75:19532     192.168.1.206:59722    ESTABLISHED     10440',
    '  TCP    192.168.1.75:19532     192.168.1.206:59770    ESTABLISHED     10440',
  ].join('\r\n');

  it('finds the listening daemon PID and dedups server-side sockets', () => {
    expect(parsePidsFromNetstat(windowsOutput, 19532)).toEqual([10440]);
  });

  it('ignores a client whose port is in the foreign column, not local', () => {
    const out = '  TCP    192.168.1.75:54321     1.2.3.4:19532          ESTABLISHED     9999';
    expect(parsePidsFromNetstat(out, 19532)).toEqual([]);
  });

  it('does not match a longer port that merely ends in the same digits', () => {
    const out = '  TCP    0.0.0.0:119532         0.0.0.0:0              LISTENING       42';
    expect(parsePidsFromNetstat(out, 19532)).toEqual([]);
  });

  it('returns nothing for empty/garbage output', () => {
    expect(parsePidsFromNetstat('', 19532)).toEqual([]);
    expect(parsePidsFromNetstat('no connections', 19532)).toEqual([]);
  });
});

describe('parsePidsFromLsof', () => {
  it('parses a newline-separated PID list and dedups', () => {
    expect(parsePidsFromLsof('1234\n5678\n1234\n')).toEqual([1234, 5678]);
  });

  it('ignores blank lines and non-numeric noise', () => {
    expect(parsePidsFromLsof('\n  \nnot-a-pid\n4242\n')).toEqual([4242]);
  });
});

describe('parsePidsFromSs', () => {
  it('extracts PIDs from ss users:(...) fields', () => {
    const out =
      'LISTEN 0 511 127.0.0.1:19532 0.0.0.0:* users:(("node",pid=7777,fd=20))';
    expect(parsePidsFromSs(out)).toEqual([7777]);
  });
});
