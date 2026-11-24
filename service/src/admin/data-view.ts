// Pure helpers for the Shared data admin pages: visible escapes, bounded pretty-printing and a bounded line diff.
// Nothing here renders HTML; the views escape what these return.

/** Characters that change how text looks or reads without being visible themselves. */
const INVISIBLE_RANGES: [number, number][] = [[0, 8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0x34f, 0x34f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180d], [0x2800, 0x2800], [0x3164, 0x3164], [0xffa0, 0xffa0], [0xe0100, 0xe01ef], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xd, 0xd], [0xfe00, 0xfe0f], [0x180f, 0x180f], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a]];
const INVISIBLE = new RegExp('[' + INVISIBLE_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('') + ']', 'gu');

/**
 * Agent-written text made safe to read: bidi controls, zero-width and other invisible characters become the visible text
 * \u{202E}, so a change made only with them still shows. Every literal backslash is doubled, so typed text can
 * never look like one of these escapes (the mapping is one to one). The result is still plain text and must be HTML-escaped by the view.
 */
export function visible(s: string): string {
  // Every backslash is doubled, so a real escape (one backslash) can never be mistaken for typed text, wherever it sits.
  return s.replace(/\\/g, '\\\\').replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
}

export const PRETTY_CAP = 256 * 1024;
export const DIFF_CELLS_CAP = 4_000_000;
export const DIFF_CHANGED_CAP = 2000;
const CONTEXT = 3;

/** Pretty-printed JSON for stored value text, or null past the cap (the page then shows the raw stored text). */
export function pretty(valueText: string): string | null {
  let text: string;
  try {
    text = JSON.stringify(JSON.parse(valueText), null, 2);
  } catch {
    return null;
  }
  return new TextEncoder().encode(text).length > PRETTY_CAP ? null : text;
}

export type DiffLine = { t: ' ' | '+' | '-' | '…'; text: string };

/**
 * A line diff, or null when it is too big (more than DIFF_CELLS_CAP table cells after trimming the common ends, or more
 * than DIFF_CHANGED_CAP changed lines). Unchanged runs are cut to CONTEXT lines around each change.
 */
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  let lo = 0;
  while (lo < x.length && lo < y.length && x[lo] === y[lo]) lo++;
  let hx = x.length;
  let hy = y.length;
  while (hx > lo && hy > lo && x[hx - 1] === y[hy - 1]) {
    hx--;
    hy--;
  }
  const n = hx - lo;
  const m = hy - lo;
  if ((n + 1) * (m + 1) > DIFF_CELLS_CAP) return null;
  // LCS table over the differing middle.
  const w = m + 1;
  const t = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = x[lo + i] === y[lo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < lo; i++) out.push({ t: ' ', text: x[i]! });
  let i = 0;
  let j = 0;
  let changed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[lo + i] === y[lo + j]) {
      out.push({ t: ' ', text: x[lo + i]! });
      i++;
      j++;
    } else if (i < n && (j === m || t[(i + 1) * w + j]! >= t[i * w + j + 1]!)) {
      out.push({ t: '-', text: x[lo + i]! });
      i++;
      changed++;
    } else {
      out.push({ t: '+', text: y[lo + j]! });
      j++;
      changed++;
    }
    if (changed > DIFF_CHANGED_CAP) return null;
  }
  for (let k = hx; k < x.length; k++) out.push({ t: ' ', text: x[k]! });
  return collapse(out);
}

function collapse(lines: DiffLine[]): DiffLine[] {
  if (lines.every((l) => l.t === ' ')) return [];
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === ' ') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ t: '…', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ t: '…', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}

/** What the version page shows: one diff against the previous version, or the stored texts when it cannot. */
export function versionBody(
  now: string | null,
  before: string | null,
): { kind: 'diff'; lines: DiffLine[] } | { kind: 'raw'; why: string; now: string | null; before: string | null } {
  const a = before === null ? '' : pretty(before);
  const b = now === null ? '' : pretty(now);
  if (a === null || b === null) {
    return { kind: 'raw', why: `A value is too large to pretty-print (over ${PRETTY_CAP / 1024} KiB), so there is no diff. The stored texts are shown.`, now, before };
  }
  // Made visible first, so a change made only with invisible characters shows as a change.
  const lines = lineDiff(visible(a), visible(b));
  if (lines === null) {
    return { kind: 'raw', why: `Too many changes to show as a diff (more than ${DIFF_CHANGED_CAP} changed lines, or too large to compare). Both versions are shown.`, now: b === '' ? null : b, before: a === '' ? null : a };
  }
  return { kind: 'diff', lines };
}
