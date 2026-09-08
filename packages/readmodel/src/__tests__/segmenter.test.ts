import { describe, expect, it } from 'vitest';
import { segmentForIndex } from '../segmenter.js';

describe('segmentForIndex', () => {
  it('leaves Latin text byte-identical', () => {
    // The common case. Touching it would corrupt snippets for almost every document,
    // and would turn "don't" into something no query matches.
    for (const text of [
      'The quick brown fox',
      "don't stop — it's fine",
      'code_block, camelCase, kebab-case',
      'https://example.com/path?q=1',
      '',
    ]) {
      expect(segmentForIndex(text)).toBe(text);
    }
  });

  it('splits Chinese into words so a two-character query can match', () => {
    // The exact case the trigram tokenizer cannot handle: most Chinese words are two
    // characters, and trigram matches nothing shorter than three.
    const segmented = segmentForIndex('知识管理系统');
    expect(segmented).not.toBe('知识管理系统');
    expect(segmented.split(' ').length).toBeGreaterThan(1);
  });

  it('splits Japanese', () => {
    const segmented = segmentForIndex('日本語のテキストです');
    expect(segmented.split(' ').length).toBeGreaterThan(1);
  });

  it('splits Korean', () => {
    expect(segmentForIndex('한국어 텍스트').split(' ').length).toBeGreaterThan(1);
  });

  it('handles mixed scripts without disturbing the Latin part', () => {
    const segmented = segmentForIndex('Meeting notes 会议记录 for Q3');
    expect(segmented).toContain('Meeting');
    expect(segmented).toContain('notes');
    expect(segmented).toContain('Q3');
    // And the Chinese run gained a boundary.
    expect(segmented).not.toContain('会议记录');
  });

  it('is idempotent, so re-indexing already-segmented text is safe', () => {
    const once = segmentForIndex('知识管理');
    expect(segmentForIndex(once)).toBe(once);
  });

  it('collapses whitespace rather than emitting doubled spaces', () => {
    expect(segmentForIndex('a 会议 b')).not.toMatch(/ {2}/);
  });
});
