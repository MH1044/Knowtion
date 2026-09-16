import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isSubPath } from '../paths.js';

describe('isSubPath', () => {
  it('treats a directory as inside itself', () => {
    expect(isSubPath('/a/b', '/a/b', posix)).toBe(true);
    expect(isSubPath('C:\\a\\b', 'C:\\a\\b', win32)).toBe(true);
  });

  it('accepts a descendant at any depth', () => {
    expect(isSubPath('/a', '/a/b/c/d', posix)).toBe(true);
    expect(isSubPath('C:\\a', 'C:\\a\\b\\c', win32)).toBe(true);
  });

  it('rejects a sibling whose name merely extends the parent', () => {
    // The classic startsWith bug: /a/b is not inside /a/bc, and neither is /a/bc in /a/b.
    expect(isSubPath('/a/b', '/a/bc', posix)).toBe(false);
    expect(isSubPath('/a/bc', '/a/b', posix)).toBe(false);
    expect(isSubPath('C:\\a\\b', 'C:\\a\\bc', win32)).toBe(false);
  });

  it('rejects an ancestor', () => {
    expect(isSubPath('/a/b', '/a', posix)).toBe(false);
    expect(isSubPath('C:\\a\\b', 'C:\\a', win32)).toBe(false);
  });

  it('resolves .. before deciding, so an escape is caught', () => {
    expect(isSubPath('/root', '/root/x/../..', posix)).toBe(false);
    expect(isSubPath('/root', '/root/x/../y', posix)).toBe(true);
    expect(isSubPath('C:\\root', 'C:\\root\\..\\other', win32)).toBe(false);
  });

  it('folds case on Windows, where the filesystem does', () => {
    // C:\Notes and c:\notes are one directory. A check that says otherwise is a hole in
    // whatever the check protects — here, the rule keeping the index out of the log.
    expect(isSubPath('C:\\Users\\Me\\Notes', 'c:\\users\\me\\notes\\log', win32)).toBe(true);
    expect(isSubPath('C:\\Users\\Me\\Notes', 'c:\\USERS\\ME\\NOTES', win32)).toBe(true);
  });

  it('keeps case significant on POSIX', () => {
    expect(isSubPath('/a/Notes', '/a/notes/log', posix)).toBe(false);
  });

  it('accepts forward slashes as separators on Windows', () => {
    expect(isSubPath('C:/a/b', 'C:\\a\\b\\c', win32)).toBe(true);
  });

  it('handles a filesystem root, which already ends in its separator', () => {
    expect(isSubPath('/', '/anything', posix)).toBe(true);
    expect(isSubPath('C:\\', 'C:\\anything', win32)).toBe(true);
    expect(isSubPath('/', '/', posix)).toBe(true);
  });

  it('defaults to the running platform', () => {
    expect(isSubPath('.', './sub')).toBe(true);
    expect(isSubPath('.', '..')).toBe(false);
  });
});
