import { describe, expect, it } from 'vitest';

import { findUpdate } from '../updates.js';

const release = (fields: Record<string, unknown>) => () => Promise.resolve(fields);

describe('findUpdate', () => {
  it('offers a genuinely newer release', async () => {
    const found = await findUpdate(
      '0.3.0',
      release({
        tag_name: 'v0.4.0',
        html_url: 'https://example.test/releases/v0.4.0',
        body: '# Knowtion 0.4.0\n\nRelations and rollups.\nFormulas too.\n',
      }),
    );
    expect(found).toEqual({
      version: '0.4.0',
      url: 'https://example.test/releases/v0.4.0',
      notes: 'Relations and rollups. Formulas too.',
    });
  });

  it('says nothing when the running version is current or ahead', async () => {
    expect(await findUpdate('0.4.0', release({ tag_name: 'v0.4.0' }))).toBeUndefined();
    expect(await findUpdate('0.5.0', release({ tag_name: 'v0.4.0' }))).toBeUndefined();
  });

  it('ignores a draft or a pre-release, which are not for this channel', async () => {
    expect(await findUpdate('0.3.0', release({ tag_name: 'v0.4.0', draft: true }))).toBeUndefined();
    expect(
      await findUpdate('0.3.0', release({ tag_name: 'v0.4.0', prerelease: true })),
    ).toBeUndefined();
  });

  it('stays quiet when the network fails, because that is not the user’s problem', async () => {
    const failing = () => Promise.reject(new Error('offline'));
    await expect(findUpdate('0.3.0', failing)).resolves.toBeUndefined();
  });

  it('stays quiet on a response it cannot read, rather than guessing', async () => {
    expect(await findUpdate('0.3.0', () => Promise.resolve(null))).toBeUndefined();
    expect(await findUpdate('0.3.0', () => Promise.resolve('nonsense'))).toBeUndefined();
    expect(await findUpdate('0.3.0', release({}))).toBeUndefined();
    expect(await findUpdate('0.3.0', release({ tag_name: 'latest' }))).toBeUndefined();
  });

  it('falls back to the releases page when the response has no link', async () => {
    const found = await findUpdate('0.3.0', release({ tag_name: '0.4.0' }));
    expect(found?.url).toContain('github.com');
    expect(found?.notes).toBe('');
  });
});
