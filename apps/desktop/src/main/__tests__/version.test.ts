import { describe, expect, it } from 'vitest';

import { compareVersions, isNewerVersion, parseVersion } from '../../shared/version.js';

describe('parseVersion', () => {
  it('reads the shapes this project publishes, with or without the tag prefix', () => {
    expect(parseVersion('0.3.0')).toEqual({ major: 0, minor: 3, patch: 0, prerelease: [] });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion(' v10.20.30 ')).toEqual({
      major: 10,
      minor: 20,
      patch: 30,
      prerelease: [],
    });
    expect(parseVersion('0.4.0-beta.2')?.prerelease).toEqual(['beta', '2']);
    expect(parseVersion('0.4.0+build.7')?.prerelease).toEqual([]);
  });

  it('refuses anything else rather than guessing', () => {
    for (const text of ['', 'latest', '1.2', '1.2.3.4', 'v', '1.2.x', 'release-1.2.3']) {
      expect(parseVersion(text), text).toBeUndefined();
    }
  });
});

describe('compareVersions', () => {
  const v = (text: string) => {
    const parsed = parseVersion(text);
    if (parsed === undefined) throw new Error(`not a version: ${text}`);
    return parsed;
  };
  const order = (a: string, b: string) => Math.sign(compareVersions(v(a), v(b)));

  it('orders by major, then minor, then patch', () => {
    expect(order('1.0.0', '0.9.9')).toBe(1);
    expect(order('0.4.0', '0.3.9')).toBe(1);
    expect(order('0.3.1', '0.3.0')).toBe(1);
    expect(order('0.3.0', '0.3.0')).toBe(0);
  });

  it('does not compare numbers as text, which is the classic mistake', () => {
    expect(order('0.10.0', '0.9.0')).toBe(1);
    expect(order('1.0.0', '0.100.0')).toBe(1);
  });

  it('puts a pre-release before the release it leads to', () => {
    expect(order('0.4.0-beta.1', '0.4.0')).toBe(-1);
    expect(order('0.4.0', '0.4.0-beta.1')).toBe(1);
    expect(order('0.4.0-beta.2', '0.4.0-beta.1')).toBe(1);
    expect(order('0.4.0-alpha', '0.4.0-beta')).toBe(-1);
    // Fewer identifiers lose when the earlier ones match.
    expect(order('0.4.0-beta', '0.4.0-beta.1')).toBe(-1);
    // A number has lower precedence than a word.
    expect(order('0.4.0-1', '0.4.0-alpha')).toBe(-1);
  });
});

describe('isNewerVersion', () => {
  it('is true only for a genuinely later release', () => {
    expect(isNewerVersion('0.4.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('v0.4.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.3.0')).toBe(false);
  });

  it('never prompts on a version it cannot read, in either direction', () => {
    // A malformed tag on the releases page must not produce an update prompt.
    expect(isNewerVersion('latest', '0.3.0')).toBe(false);
    expect(isNewerVersion('', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.4.0', 'unknown')).toBe(false);
  });
});
