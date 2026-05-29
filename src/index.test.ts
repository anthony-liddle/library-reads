import { describe, expect, it } from 'vitest';
import type { ReadEntry } from './index.js';

describe('library-reads wiring', () => {
  it('exposes the ReadEntry type and runs the test runner', () => {
    const entry: ReadEntry = {
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      status: 'finished',
      sortDate: '1969-03-01',
      provenance: 'extras',
    };

    expect(entry.title).toBe('The Left Hand of Darkness');
    expect(true).toBe(true);
  });
});
