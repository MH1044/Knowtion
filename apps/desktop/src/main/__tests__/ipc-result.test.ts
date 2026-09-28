import { describe, expect, it } from 'vitest';

import { settle } from '../ipc-result.js';

describe('an IPC handler result', () => {
  it('carries a plain value', async () => {
    expect(await settle(() => 3)).toEqual({ ok: true, value: 3 });
  });

  it('waits for an async handler, so its value and not a Promise is sent', async () => {
    const result = await settle(async () => {
      await Promise.resolve();
      return { version: '0.4.1' };
    });
    expect(result).toEqual({ ok: true, value: { version: '0.4.1' } });
    // What Electron does with it: a Promise cannot be structured-cloned, this can.
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('turns a throw or a rejection into a message', async () => {
    expect(
      await settle(() => {
        throw new Error('nope');
      }),
    ).toEqual({ ok: false, error: 'nope' });
    expect(await settle(() => Promise.reject(new Error('later')))).toEqual({
      ok: false,
      error: 'later',
    });
  });
});
