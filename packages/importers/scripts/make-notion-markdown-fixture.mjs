// Builds fixtures/notion-markdown/export.zip: a Notion "Markdown & CSV" export in the layout
// Notion writes, for the importer's tests. Hand-made, not a real export: nobody on the
// project had one to hand when Markdown import was added. Rebuild only if the layout it
// models is found to be wrong, and say how in the commit.
//
//   node packages/importers/scripts/make-notion-markdown-fixture.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { strToU8, zipSync } from 'fflate';

const root = 'Export-7c1e2b9a-4d3f-4b1a-9c2e-5f6a7b8c9d0e';
const home = 'Home 1a2b3c4d5e6f40718293a4b5c6d7e8f9';
const wiki = 'Wiki 2b3c4d5e6f7a41829304b5c6d7e8f9a0';
const review = 'Code review 3c4d5e6f7a8b42930415c6d7e8f9a0b1';
const books = 'Books 4d5e6f7a8b9c43a41526d7e8f9a0b1c2';
const dune = 'Dune 5e6f7a8b9cad44b52637e8f9a0b1c2d3';
const emma = 'Emma 6f7a8b9cadbe45c63748f9a0b1c2d3e4';

const files = {
  [`${root}/${home}.md`]: [
    '# Home',
    '',
    'Welcome to my **personal** page with *some italic*, `code`, ~~struck~~ and a',
    '[link](https://example.com) and a line  ',
    'break.',
    '',
    '## Lists',
    '',
    '- First bullet',
    '- Second bullet',
    '    - Nested bullet',
    '',
    '1. One',
    '2. Two',
    '',
    '- [ ] Call the dentist',
    '- [x] Renew passport',
    '',
    '> A quote',
    '',
    '```js',
    'let x = 1;',
    '```',
    '',
    '---',
    '',
    '<aside>',
    '💡 Remember the milk',
    '',
    '</aside>',
    '',
    '| Name | Qty |',
    '| --- | --- |',
    '| Apples | 3 |',
    '',
    '![Photo](Home%201a2b3c4d5e6f40718293a4b5c6d7e8f9/photo.png)',
    '',
    `See the [Wiki](Home%201a2b3c4d5e6f40718293a4b5c6d7e8f9/${encodeURIComponent(wiki)}.md) and [Books](${encodeURIComponent(books)}.csv).`,
    '',
  ].join('\n'),
  [`${root}/${home}/${wiki}.md`]: '# Wiki\n\nHow we work.\n',
  [`${root}/${home}/${wiki}/${review}.md`]: '# Code review\n\nTwo approvals.\n',
  [`${root}/${home}/photo.png`]: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  [`${root}/${books}.csv`]:
    'Name,Tags,Status\nDune,"Sci-fi, Classic",Done\nEmma,Classic,In progress\n',
  [`${root}/${books}_all.csv`]:
    String.fromCodePoint(0xfeff) +
    'Name,Tags,Status\r\nDune,"Sci-fi, Classic",Done\r\nEmma,Classic,In progress\r\n',
  [`${root}/${books}/${dune}.md`]:
    '# Dune\n\nTags: Sci-fi, Classic\nStatus: Done\n\nNotes on Dune: read it twice.\n',
  [`${root}/${books}/${emma}.md`]: '# Emma\n\nTags: Classic\nStatus: In progress\n',
};

const zip = zipSync(
  Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      [typeof content === 'string' ? strToU8(content) : content, { mtime: new Date(2026, 8, 28) }],
    ]),
  ),
);
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'notion-markdown',
  'export.zip',
);
writeFileSync(out, zip);
console.log(`wrote ${out}, ${zip.length} bytes`);
