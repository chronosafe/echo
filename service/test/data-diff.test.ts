import { describe, expect, it } from 'vitest';
const c = (n: number) => String.fromCodePoint(n);
import { DIFF_CHANGED_CAP, PRETTY_CAP, lineDiff, pretty, visible } from '../src/admin/data-view';

const show = (d: ReturnType<typeof lineDiff>) => d!.map((l) => `${l.t}${l.text}`);

describe('visible escapes', () => {
  it('shows bidi, zero-width and control characters as text instead of stripping them', () => {
    expect(visible('a\u202Eb')).toBe('a\\u{202E}b');
    expect(visible('a\u200Bb\u200Dc\uFEFFd')).toBe('a\\u{200B}b\\u{200D}c\\u{FEFF}d');
    expect(visible('x\u2066y\u2069')).toBe('x\\u{2066}y\\u{2069}');
    expect(visible('nul\u0000 bell\u0007 del\u007f')).toBe('nul\\u{0} bell\\u{7} del\\u{7F}');
    expect(visible('\u{E0041}')).toBe('\\u{E0041}');
  });
  it('keeps newline, tab and ordinary text, and leaves emoji alone', () => {
    expect(visible('a\nb\tc \u{1F600} é')).toBe('a\nb\tc \u{1F600} é');
  });
  it('every backslash is doubled, so typed text never looks like a real escape, wherever the invisible character sits', () => {
    const rlo = String.fromCodePoint(0x202e);
    const bs = String.fromCharCode(92);
    expect(visible(bs + 'u{202E}')).toBe(bs + bs + 'u{202E}');
    expect(visible(bs + rlo)).toBe(bs + bs + bs + 'u{202E}');
    expect(visible(bs + 'u{202E}')).not.toBe(visible(bs + rlo));
    expect(visible('C:' + bs + 'users')).toBe('C:' + bs + bs + 'users');
    expect(lineDiff(visible(bs + 'u{202E}'), visible(bs + rlo))).not.toEqual([]);
  });
  it('also shows the other default-ignorable characters that render as nothing', () => {
    for (const cp of [0xfe0f, 0x180f, 0xfff0, 0x1bca0, 0x1d173, 0x34f, 0x115f, 0x17b4, 0x180b, 0x2800, 0x3164, 0xffa0, 0xe0100]) {
      expect(visible('a' + String.fromCodePoint(cp) + 'b'), cp.toString(16)).toBe('a' + String.fromCharCode(92) + 'u{' + cp.toString(16).toUpperCase() + '}b');
    }
  });
  it('shows look-alike spaces, so a space changed to a no-break space is visible', () => {
    for (const cp of [0xa0, 0x2003, 0x202f, 0x3000]) expect(visible('a' + String.fromCodePoint(cp) + 'b')).toBe('a' + String.fromCharCode(92) + 'u{' + cp.toString(16).toUpperCase() + '}b');
    expect(visible('a b')).toBe('a b');
  });
  it('two texts that differ only in an invisible character stay different', () => {
    expect(visible('ab')).not.toBe(visible('a\u200Bb'));
  });
});

describe('pretty', () => {
  it('prints stored JSON with two-space indent', () => {
    expect(pretty('{"a":[1,2],"b":{"c":null}}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  }\n}');
    expect(pretty('"x"')).toBe('"x"');
  });
  it('gives up past the cap, so the page shows the raw stored text', () => {
    const wide = JSON.stringify(Array.from({ length: 30000 }, () => ({ a: 1 }))); // ~240 KB compact, much more pretty
    expect(wide.length).toBeLessThanOrEqual(65536 * 4);
    expect(pretty(wide)).toBeNull();
    expect(PRETTY_CAP).toBe(262144);
  });
});

describe('line diff', () => {
  it('finds exact added, removed and unchanged lines', () => {
    expect(show(lineDiff('a\nb\nc', 'a\nB\nc'))).toEqual([' a', '-b', '+B', ' c']);
    expect(show(lineDiff('a\nb', 'a\nb\nc'))).toEqual([' a', ' b', '+c']);
    expect(show(lineDiff('x\ny\nz', 'y'))).toEqual(['-x', ' y', '-z']);
  });
  it('a delete diffs old to empty and a recreate diffs empty to new', () => {
    expect(show(lineDiff('{\n  "a": 1\n}', ''))).toEqual(['-{', '-  "a": 1', '-}']);
    expect(show(lineDiff('', '{\n  "a": 1\n}'))).toEqual(['+{', '+  "a": 1', '+}']);
    expect(lineDiff('', '')).toEqual([]);
  });
  it('shows a change made only with an invisible character once the lines are made visible', () => {
    const d = lineDiff(visible('"ab"'), visible('"a\u200Bb"'))!;
    expect(show(d)).toEqual(['-"ab"', '+"a\\u{200B}b"']);
  });
  it('collapses long unchanged runs to three lines of context', () => {
    const base = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const changed = [...base];
    changed[20] = 'CHANGED';
    expect(show(lineDiff(base.join('\n'), changed.join('\n')))).toEqual(['…17 unchanged lines', ' l17', ' l18', ' l19', '-l20', '+CHANGED', ' l21', ' l22', ' l23', '…16 unchanged lines']);
  });
  it('gives up (null) past the changed-line cap and past the cell cap', () => {
    const many = Array.from({ length: DIFF_CHANGED_CAP + 50 }, (_, i) => `a${i}`).join('\n');
    const other = Array.from({ length: DIFF_CHANGED_CAP + 50 }, (_, i) => `b${i}`).join('\n');
    expect(lineDiff(many, other)).toBeNull();
    const big = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const big2 = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    expect(lineDiff(big, big2)).toBeNull();
  });
  it('worst cases stay fast: alternating changes in a 64 KiB value, and the cell cap just under its limit', () => {
    const a = JSON.stringify(Array.from({ length: 16000 }, () => 0));
    const b = JSON.stringify(Array.from({ length: 16000 }, (_, i) => (i % 2 ? 1 : 0)));
    const t0 = performance.now();
    const pa = pretty(a)!;
    const pb = pretty(b)!;
    const d = lineDiff(pa, pb);
    const ms = performance.now() - t0;
    expect(d === null || d.length > 0).toBe(true);
    expect(ms, `diff of 16,000-line values took ${ms.toFixed(0)} ms`).toBeLessThan(3000);
    // about 1,990 differing lines each side: close to the cell cap, the heaviest case that still runs
    const x = Array.from({ length: 1990 }, (_, i) => `a${i}`).join('\n');
    const y = Array.from({ length: 1990 }, (_, i) => `b${i}`).join('\n');
    const t1 = performance.now();
    const r = lineDiff(x, y);
    const ms2 = performance.now() - t1;
    expect(r === null || r.length > 0).toBe(true);
    expect(ms2, `1,990x1,990 diff took ${ms2.toFixed(0)} ms`).toBeLessThan(3000);
  });
});
