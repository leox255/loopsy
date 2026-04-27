import { describe, it, expect } from 'vitest';
import { isGuiClassCommand, detectSessionContext } from '../src/utils/session-context.js';

describe('isGuiClassCommand', () => {
  it.each([
    ['open', true],
    ['/usr/bin/open', true],
    ['osascript', true],
    ['/usr/bin/osascript', true],
    ['OSASCRIPT', true],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', true],
    ['/System/Applications/Notes.app/Contents/MacOS/Notes', true],
    ['echo', false],
    ['ls', false],
    ['/bin/sh', false],
    ['/usr/local/bin/node', false],
    ['/Users/foo/bin/open-something', false], // basename is 'open-something', not 'open'
  ])('classifies %j as gui=%s', (cmd, expected) => {
    expect(isGuiClassCommand(cmd)).toBe(expected);
  });
});

describe('detectSessionContext', () => {
  it('returns the current daemon user info', () => {
    const ctx = detectSessionContext();
    expect(typeof ctx.daemonUser).toBe('string');
    expect(ctx.daemonUser.length).toBeGreaterThan(0);
    expect(typeof ctx.daemonUid).toBe('number');
    expect(ctx.daemonIsRoot).toBe(ctx.daemonUid === 0);
  });

  it('on non-darwin, console fields are null and never mismatched', () => {
    if (process.platform === 'darwin') return; // covered by darwin-specific behavior
    const ctx = detectSessionContext();
    expect(ctx.consoleUser).toBeNull();
    expect(ctx.consoleUid).toBeNull();
    expect(ctx.mismatched).toBe(false);
  });

  it('on darwin, mismatched is consistent with consoleUser presence', () => {
    if (process.platform !== 'darwin') return;
    const ctx = detectSessionContext();
    if (ctx.consoleUser === null) {
      expect(ctx.mismatched).toBe(false);
    } else {
      expect(ctx.mismatched).toBe(ctx.consoleUser !== ctx.daemonUser);
    }
  });
});
