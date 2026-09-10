import { describe, expect, it } from 'vitest';

import { isTransientReadError } from '../read-errors.js';

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`simulated ${code}`), { code });

describe('classifying a failed read', () => {
  it.each([
    ['EBUSY', 'the sync client is holding the file open'],
    ['EPERM', 'a Windows sharing violation'],
    ['EACCES', 'a placeholder the provider refused to recall'],
    ['EIO', 'the device gave up mid-read'],
    ['ETIMEDOUT', 'a recall that never completed'],
    ['EMFILE', 'a large reconcile scan exhausting handles'],
    ['UNKNOWN', 'libuv has no mapping for the Windows code'],
  ])('treats %s as worth retrying (%s)', (code) => {
    expect(isTransientReadError(errno(code))).toBe(true);
  });

  it('does not treat ENOENT as a read failure at all', () => {
    // The port already turns absence into undefined, and a missing object is a normal
    // state during sync rather than something to retry.
    expect(isTransientReadError(errno('ENOENT'))).toBe(false);
  });

  it('refuses anything it does not recognise', () => {
    // The default matters more than the list. Treating a permanent failure as transient
    // means retrying it forever and never reporting it — which is the silent skip
    // FORMAT.md section 3 forbids.
    expect(isTransientReadError(errno('EROFS'))).toBe(false);
    expect(isTransientReadError(new Error('no code at all'))).toBe(false);
  });

  it('survives values that are not errors', () => {
    for (const value of [undefined, null, 'EBUSY', 42, {}, { code: 7 }]) {
      expect(isTransientReadError(value)).toBe(false);
    }
  });
});
