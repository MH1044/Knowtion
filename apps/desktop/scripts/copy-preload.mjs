/**
 * Copy the preload script into the build output.
 *
 * It is hand-written CommonJS rather than compiled TypeScript because a sandboxed
 * preload cannot use ES modules, and sandbox:true is what keeps a compromised renderer
 * away from Node. So it is copied verbatim rather than passing through tsc.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(appRoot, 'dist', 'preload');

await mkdir(target, { recursive: true });
await copyFile(join(appRoot, 'src', 'preload', 'preload.cjs'), join(target, 'preload.cjs'));
console.log('copied preload.cjs');
