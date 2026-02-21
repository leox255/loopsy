import { describe, it, expect } from 'vitest';
import { LoopsyError, LoopsyErrorCode } from '../src/errors.js';

describe('LoopsyError', () => {
  it('creates error with code and message', () => {
    const err = new LoopsyError(LoopsyErrorCode.AUTH_INVALID_KEY, 'Bad key');
    expect(err.code).toBe(1002);
    expect(err.message).toBe('Bad key');
    expect(err.name).toBe('LoopsyError');
  });

  it('serializes to JSON', () => {
    const err = new LoopsyError(LoopsyErrorCode.EXEC_COMMAND_DENIED, 'rm denied', { command: 'rm' });
    const json = err.toJSON();
    expect(json.error.code).toBe(3001);
    expect(json.error.message).toBe('rm denied');
    expect(json.error.details).toEqual({ command: 'rm' });
  });
});
