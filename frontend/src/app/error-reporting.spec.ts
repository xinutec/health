import { describe, expect, it } from 'vitest';

import { messageOf } from './error-reporting';

describe('messageOf', () => {
  it('reads an Error by its message', () => {
    expect(messageOf(new Error('the chart failed'))).toBe('the chart failed');
  });

  it('unwraps a rejected promise', () => {
    expect(messageOf({ rejection: new Error('the fetch failed') })).toBe('the fetch failed');
  });

  it('keeps a thrown string', () => {
    expect(messageOf('plain words')).toBe('plain words');
  });

  it('names a thrown object rather than printing [object Object]', () => {
    expect(messageOf({ status: 500 })).toBe('non-Error thrown');
  });
});
