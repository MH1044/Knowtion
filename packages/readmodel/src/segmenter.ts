/**
 * Word segmentation for the search index.
 *
 * SQLite's default unicode61 tokenizer treats every Han character as a token character
 * with no separators, so an entire Chinese paragraph becomes one token and search for
 * anything inside it returns nothing. The trigram tokenizer does not rescue it either:
 * SQLite states that substrings of fewer than three characters match no rows, and most
 * Chinese words are two characters.
 *
 * A custom FTS5 tokenizer cannot be registered from JavaScript, so segmentation happens
 * here, in the application layer, before text reaches the index. This has to be settled
 * before the first index is built — discovering it later means shipping a forced
 * reindex to everyone, which is why index_version exists.
 *
 * Only scripts that need it are touched. Latin text passes through byte-identical, so
 * snippets and highlights are unaffected for the overwhelming majority of documents,
 * and the common case costs one regular expression test.
 */

/**
 * Characters written without spaces between words: Han, Hiragana, Katakana, Hangul,
 * plus Thai, Lao, Khmer and Myanmar. Anything else already has whitespace to tokenize on.
 */
const NEEDS_SEGMENTING = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯฀-๿຀-໿ក-៿က-႟]/u;

/** Runs of such characters, so surrounding Latin text can be left alone. */
const RUNS = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯฀-๿຀-໿ក-៿က-႟]+/gu;

let segmenter: Intl.Segmenter | undefined;

function words(run: string): string {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const parts: string[] = [];
  for (const { segment } of segmenter.segment(run)) {
    if (segment.trim().length > 0) parts.push(segment);
  }
  return parts.join(' ');
}

/**
 * Prepare text for indexing.
 *
 * Must be applied identically to indexed text and to search queries. Indexing
 * segmented text and then querying with unsegmented text finds nothing, and the
 * failure is silent — it looks like the document simply is not there.
 */
export function segmentForIndex(text: string): string {
  if (!NEEDS_SEGMENTING.test(text)) return text;
  return text
    .replace(RUNS, (run) => ` ${words(run)} `)
    .replace(/\s+/g, ' ')
    .trim();
}
