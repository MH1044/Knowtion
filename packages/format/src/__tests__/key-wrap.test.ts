import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF_PARAMS,
  FIRST_KEY_EPOCH,
  KeyWrapError,
  RecoveryPhraseError,
  WORKSPACE_KEY_SIZE,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateWorkspaceKey,
  rotateWorkspaceKey,
  unwrapKeyFromDevice,
  unwrapKeyFromRecoveryPhrase,
  wrapKeyToDevice,
  wrapKeyToRecoveryPhrase,
} from '../index.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const OTHER_WORKSPACE = new Uint8Array(16).fill(0x22);

/**
 * Argon2id at the shipped cost is 766 ms, which would put minutes on this file. The
 * parameters are data carried in the record, so the code path under test is identical;
 * DEFAULT_KDF_PARAMS is asserted separately below.
 */
const FAST = { m: 8192, t: 1, p: 1 };

const problemOf = (fn: () => unknown): KeyWrapError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KeyWrapError);
    return error as KeyWrapError;
  }
  throw new Error('expected the wrap to be rejected');
};

describe('the workspace key', () => {
  it('is 32 random bytes', () => {
    const a = generateWorkspaceKey();
    const b = generateWorkspaceKey();
    expect(a.key).toHaveLength(WORKSPACE_KEY_SIZE);
    expect(a.key).not.toEqual(b.key);
  });

  it('starts at the first epoch, which is never zero', () => {
    // key_epoch 0 is reserved for suite NONE, so a non-zero epoch means "encrypted"
    // without a reader having to cross-check suite_id.
    expect(generateWorkspaceKey().epoch).toBe(FIRST_KEY_EPOCH);
    expect(FIRST_KEY_EPOCH).toBeGreaterThan(0);
  });

  it('rotates to a new epoch with entirely new key material', () => {
    const first = generateWorkspaceKey();
    const second = rotateWorkspaceKey(first);
    expect(second.epoch).toBe(first.epoch + 1);
    expect(second.key).not.toEqual(first.key);
  });

  it('refuses an epoch below the first', () => {
    expect(() => generateWorkspaceKey(0)).toThrow(TypeError);
  });

  it('ships the RFC 9106 second recommended cost', () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({ m: 65536, t: 3, p: 4 });
  });
});

describe('wrapping to a device', () => {
  const device = generateDeviceKeys();
  const workspaceKey = generateWorkspaceKey();
  const record = wrapKeyToDevice(workspaceKey, WORKSPACE, device.wrappingPublicKey);

  it('round-trips the key and its epoch', () => {
    const opened = unwrapKeyFromDevice(record, device.wrappingSecretKey, WORKSPACE);
    expect(opened.key).toEqual(workspaceKey.key);
    expect(opened.epoch).toBe(workspaceKey.epoch);
  });

  it('never puts the key in the record', () => {
    expect(Buffer.from(record).includes(Buffer.from(workspaceKey.key))).toBe(false);
  });

  it('produces a different record every time, from the ephemeral key', () => {
    const again = wrapKeyToDevice(workspaceKey, WORKSPACE, device.wrappingPublicKey);
    expect(again).not.toEqual(record);
    expect(unwrapKeyFromDevice(again, device.wrappingSecretKey, WORKSPACE).key).toEqual(
      workspaceKey.key,
    );
  });

  it('tells a device the wrap was meant for someone else', () => {
    // Normal during pairing: a device reads a folder full of wraps and most are not
    // its own. It must not read like damage.
    const other = generateDeviceKeys();
    const error = problemOf(() => unwrapKeyFromDevice(record, other.wrappingSecretKey, WORKSPACE));
    expect(error.problem).toBe('WRONG_KEY');
    expect(error.message).toContain('different device');
  });

  it('refuses a wrap from another workspace', () => {
    expect(
      problemOf(() => unwrapKeyFromDevice(record, device.wrappingSecretKey, OTHER_WORKSPACE))
        .problem,
    ).toBe('WRONG_WORKSPACE');
  });

  it('refuses an unusable recipient key', () => {
    expect(
      problemOf(() => wrapKeyToDevice(workspaceKey, WORKSPACE, new Uint8Array(32))).problem,
    ).toBe('MALFORMED');
  });

  it('rejects a single flipped bit anywhere in the record', () => {
    let rejected = 0;
    let attempts = 0;
    for (let i = 0; i < record.length; i += 7) {
      const tampered = Uint8Array.from(record);
      tampered[i]! ^= 0x01;
      attempts++;
      // Any rejection is correct. What must never happen is a DIFFERENT key coming
      // back, because that is the failure a caller cannot detect.
      try {
        expect(unwrapKeyFromDevice(tampered, device.wrappingSecretKey, WORKSPACE).key).toEqual(
          workspaceKey.key,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(KeyWrapError);
        rejected++;
      }
    }
    // Counted so the assertion above cannot pass by never running.
    expect(attempts).toBeGreaterThan(10);
    expect(rejected).toBeGreaterThan(attempts / 2);
  });
});

describe('wrapping to the recovery phrase', () => {
  const phrase = generateRecoveryPhrase();
  const workspaceKey = generateWorkspaceKey();
  const record = wrapKeyToRecoveryPhrase(workspaceKey, WORKSPACE, phrase, FAST);

  it('round-trips the key and its epoch', () => {
    const opened = unwrapKeyFromRecoveryPhrase(record, phrase, WORKSPACE);
    expect(opened.key).toEqual(workspaceKey.key);
    expect(opened.epoch).toBe(workspaceKey.epoch);
  });

  it('never puts the key in the record', () => {
    expect(Buffer.from(record).includes(Buffer.from(workspaceKey.key))).toBe(false);
  });

  it('opens for a phrase pasted with a trailing newline and the wrong case', () => {
    // The whole point of the normalisation layer, exercised end to end rather than
    // only against the phrase parser: this is what recovery day actually looks like.
    const opened = unwrapKeyFromRecoveryPhrase(record, `  ${phrase.toUpperCase()}\n`, WORKSPACE);
    expect(opened.key).toEqual(workspaceKey.key);
  });

  it('refuses the wrong phrase', () => {
    const error = problemOf(() =>
      unwrapKeyFromRecoveryPhrase(record, generateRecoveryPhrase(), WORKSPACE),
    );
    expect(error.problem).toBe('WRONG_KEY');
  });

  it('refuses a mistyped phrase before spending a second on Argon2id', () => {
    // A checksum failure is not a KeyWrapError: it is a typo, and saying so is more
    // useful than "the wrap did not open".
    expect(() => unwrapKeyFromRecoveryPhrase(record, 'clearly not a phrase', WORKSPACE)).toThrow(
      RecoveryPhraseError,
    );
  });

  it('will not write a wrap under a phrase that does not check out', () => {
    // Writing one would produce a file that looks correct and can never be opened.
    expect(() => wrapKeyToRecoveryPhrase(workspaceKey, WORKSPACE, 'nonsense', FAST)).toThrow(
      RecoveryPhraseError,
    );
  });

  it('refuses a wrap from another workspace', () => {
    expect(
      problemOf(() => unwrapKeyFromRecoveryPhrase(record, phrase, OTHER_WORKSPACE)).problem,
    ).toBe('WRONG_WORKSPACE');
  });

  it('carries its own cost, so it opens without any other file', () => {
    const cheap = wrapKeyToRecoveryPhrase(workspaceKey, WORKSPACE, phrase, { m: 8192, t: 2, p: 1 });
    expect(unwrapKeyFromRecoveryPhrase(cheap, phrase, WORKSPACE).key).toEqual(workspaceKey.key);
  });

  it('refuses a cost outside the accepted range, in both directions', () => {
    // The ceiling is the load-bearing one: a hostile recovery.wrap in a shared folder
    // asking for terabytes of memory is a denial of service that costs one line.
    for (const bad of [
      { m: 1, t: 1, p: 1 },
      { m: 8_589_934_592, t: 1, p: 1 },
      { m: 8192, t: 999, p: 1 },
      { m: 8192, t: 1, p: 999 },
    ]) {
      expect(
        problemOf(() => wrapKeyToRecoveryPhrase(workspaceKey, WORKSPACE, phrase, bad)).problem,
      ).toBe('MALFORMED');
    }
  });
});

describe('rejecting records that are not wraps', () => {
  const device = generateDeviceKeys();
  const workspaceKey = generateWorkspaceKey();

  it('refuses a device wrap presented as a recovery wrap, and the reverse', () => {
    const asDevice = wrapKeyToDevice(workspaceKey, WORKSPACE, device.wrappingPublicKey);
    expect(
      problemOf(() => unwrapKeyFromRecoveryPhrase(asDevice, generateRecoveryPhrase(), WORKSPACE))
        .problem,
    ).toBe('MALFORMED');
  });

  it('refuses bytes that are not a record at all', () => {
    for (const junk of [new Uint8Array(0), new Uint8Array(64).fill(0xff)]) {
      expect(
        problemOf(() => unwrapKeyFromDevice(junk, device.wrappingSecretKey, WORKSPACE)).problem,
      ).toBe('MALFORMED');
    }
  });

  it('keeps every epoch openable, because history below it stays readable', () => {
    // Rotation protects future writes only. If an old epoch stopped unwrapping, every
    // pack written under it would become unreadable, which is data loss on revocation.
    let key = generateWorkspaceKey();
    const wraps = [wrapKeyToDevice(key, WORKSPACE, device.wrappingPublicKey)];
    for (let i = 0; i < 3; i++) {
      key = rotateWorkspaceKey(key);
      wraps.push(wrapKeyToDevice(key, WORKSPACE, device.wrappingPublicKey));
    }
    const epochs = wraps.map((w) => unwrapKeyFromDevice(w, device.wrappingSecretKey, WORKSPACE));
    expect(epochs.map((e) => e.epoch)).toEqual([1, 2, 3, 4]);
    expect(new Set(epochs.map((e) => e.key.join(','))).size).toBe(4);
  });
});
