/**
 * Cell formatting, where a day can go missing.
 *
 * The date tests are the ones that matter: a zoneless date must round-trip as the very
 * string it is, and a datetime's wall clock must survive a trip through a zone's offset
 * on both sides of a daylight-saving change. Everything here runs in Node with Intl and
 * no DOM.
 */
import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  instantToWallTime,
  isHttpUrl,
  parseNumber,
  wallTimeToInstant,
  zoneChoices,
} from '../database/format.js';

describe('dates', () => {
  it('a calendar date is shown exactly as stored, never through a Date', () => {
    expect(formatDate('2026-09-17')).toBe('2026-09-17');
    expect(formatDate('2026-01-01')).toBe('2026-01-01');
  });

  it('a datetime round-trips through the wall clock of its own zone', () => {
    const ms = Date.UTC(2026, 8, 17, 8, 30); // 08:30 UTC
    expect(instantToWallTime(ms, 'UTC')).toBe('2026-09-17T08:30');
    expect(instantToWallTime(ms, 'Europe/London')).toBe('2026-09-17T09:30'); // BST
    expect(instantToWallTime(ms, 'Asia/Tokyo')).toBe('2026-09-17T17:30');
    expect(instantToWallTime(ms, 'America/Los_Angeles')).toBe('2026-09-17T01:30');
    for (const zone of [
      'UTC',
      'Europe/London',
      'Asia/Tokyo',
      'America/Los_Angeles',
      'Asia/Kolkata',
    ]) {
      expect(wallTimeToInstant(instantToWallTime(ms, zone), zone), zone).toBe(ms);
    }
  });

  it('crosses a daylight-saving change in both directions', () => {
    // London leaves BST at 02:00 on 2026-10-25 (clocks go back to 01:00).
    const beforeChange = Date.UTC(2026, 9, 24, 12); // BST, +1
    const afterChange = Date.UTC(2026, 9, 26, 12); // GMT, +0
    expect(instantToWallTime(beforeChange, 'Europe/London')).toBe('2026-10-24T13:00');
    expect(instantToWallTime(afterChange, 'Europe/London')).toBe('2026-10-26T12:00');
    expect(wallTimeToInstant('2026-10-24T13:00', 'Europe/London')).toBe(beforeChange);
    expect(wallTimeToInstant('2026-10-26T12:00', 'Europe/London')).toBe(afterChange);
    // Los Angeles springs forward on 2026-03-08 at 02:00: 02:30 does not exist, and lands
    // on a real minute rather than being refused.
    const gap = wallTimeToInstant('2026-03-08T02:30', 'America/Los_Angeles');
    expect(gap).toBeDefined();
    expect(instantToWallTime(gap ?? 0, 'America/Los_Angeles')).toMatch(/^2026-03-08T0[13]:30$/);
  });

  it('falls back to UTC for a zone the platform does not know, and refuses junk text', () => {
    const ms = Date.UTC(2026, 0, 1, 12);
    expect(instantToWallTime(ms, 'Mars/Olympus_Mons')).toBe('2026-01-01T12:00');
    expect(wallTimeToInstant('2026-01-01T12:00', 'Mars/Olympus_Mons')).toBe(ms);
    expect(wallTimeToInstant('yesterday', 'UTC')).toBeUndefined();
    expect(wallTimeToInstant('2026-13-01T00:00', 'UTC')).toBeUndefined();
    expect(wallTimeToInstant('2026-01-01T25:00', 'UTC')).toBeUndefined();
  });

  it('formats a datetime as its wall clock with the zone named', () => {
    expect(formatDateTime(Date.UTC(2026, 8, 17, 8, 30), 'Asia/Tokyo')).toBe(
      '2026-09-17 17:30 Asia/Tokyo',
    );
  });

  it('offers the current zone first and always includes UTC', () => {
    const choices = zoneChoices('Asia/Tokyo');
    expect(choices[0]).toBe('Asia/Tokyo');
    expect(choices).toContain('UTC');
    expect(new Set(choices).size).toBe(choices.length);
  });
});

describe('numbers', () => {
  it('accepts plain, signed, decimal, scientific and thousands-grouped input', () => {
    expect(parseNumber('42')).toBe(42);
    expect(parseNumber(' -3.5 ')).toBe(-3.5);
    expect(parseNumber('1,200.5')).toBe(1200.5);
    expect(parseNumber('1,000,000')).toBe(1_000_000);
    expect(parseNumber('1e3')).toBe(1000);
    expect(parseNumber('.5')).toBe(0.5);
  });

  it('refuses text, non-finite values and ambiguous commas', () => {
    expect(parseNumber('abc')).toBeUndefined();
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('1e400')).toBeUndefined();
    expect(parseNumber('Infinity')).toBeUndefined();
    expect(parseNumber('1,5')).toBeUndefined(); // a decimal comma, or a typo: not guessed
    expect(parseNumber('12,34')).toBeUndefined();
  });
});

describe('urls', () => {
  it('links only http and https', () => {
    expect(isHttpUrl('https://example.test/x')).toBe(true);
    expect(isHttpUrl('HTTP://example.test')).toBe(true);
    expect(isHttpUrl('ftp://example.test')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('example.test')).toBe(false);
    expect(isHttpUrl('https://exa mple.test')).toBe(false);
  });
});
