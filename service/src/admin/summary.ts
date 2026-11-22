// A short, readable headline for a merge event, built deterministically from the note an agent wrote
// (no AI). The full original text is always kept by the caller behind a disclosure. The rule throughout is to be
// conservative: when unsure, show more of the note, never less, and never drop or distort a warning.

const MAX = 80;

const DAYS = String.raw`(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?`;
const TIME = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)`;
const TZ = String.raw`(?:[ECMP][SD]T|UTC|GMT|Z)`;
// A time is boilerplate only when it names a day or a zone ("Sun 6:30 PM EST", "7 PM EST"), or is the whole clause.
// "Move show to 7pm" and "Doors at 8 PM" are ordinary titles and stay as written.
const TRAILING_TIME = new RegExp(String.raw`\s+(?:(?:at|on|@)\s+)?(?:${DAYS}\s+${TIME}\s*${TZ}?|${TIME}\s*${TZ})\.?$`, 'i');
const TIME_ONLY = new RegExp(String.raw`^(?:(?:at|on|@)\s+)?(?:${DAYS}\s+)?${TIME}\s*${TZ}?\.?$`, 'i');
const LEADING_MERGE = /^(?:(?:merge|pr)\s*)*#\d+\b(?:\s*(?:and|&|,)\s*(?:(?:merge|pr)\s*)*#\d+\b)*\s*(?:[:–—]|-(?=\s))?\s*/i;
// A clause ends at a sentence stop or a semicolon, outside parentheses. A spaced dash is NOT a boundary: it is
// common inside model names ("Widget - Pro"). Abbreviations such as "St." and "Dr." do not end a sentence.
const CLAUSE_END = /(?<!\b(?:[A-Za-z]|Dr|Mr|Mrs|Ms|St|Mt|Ft|Jr|Sr|Inc|Co|Ltd|vs|etc|approx|No|Mon|Tue|Wed|Thu|Fri|Sat|Sun))\.(?:\s|$)|;\s/g;
// A warning must never be dropped from the headline: in a parenthetical, or in a later clause. A word list can never
// catch every phrasing, so anything else the headline leaves out is flagged with "more" (see Summary.more).
const WARNING =
  /\b(?:hold|on hold|do not|don['\u2019]t|never|must not|mustn['\u2019]t|cannot|can['\u2019]t|won['\u2019]t|not (?:before|until|yet)|unless|only after|wait (?:for|until)|block(?:ed|er|ing|s)?|pause[ds]?|freeze|frozen|dnm|cancel(?:led|ed)?|abort(?:ed)?|roll ?back|revert(?:ed)?|wip|superseded)\b/i;

function stripParens(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, (m) => (WARNING.test(m) ? m : ' '));
  } while (s !== prev);
  return s.replace(/\([^)]*$/, (m) => (WARNING.test(m) ? m : ' '));
}

/** Index of the first clause boundary that is not inside parentheses (a stray ")" cannot go below depth 0), or -1. */
function clauseEnd(s: string): number {
  let depth = 0;
  let pos = 0;
  for (const m of s.matchAll(CLAUSE_END)) {
    for (; pos < m.index; pos++) {
      if (s[pos] === '(') depth++;
      else if (s[pos] === ')' && depth > 0) depth--;
    }
    if (depth === 0) return m.index;
  }
  return -1;
}

function clauses(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (;;) {
    const e = clauseEnd(rest);
    if (e < 0) {
      out.push(rest);
      return out;
    }
    out.push(rest.slice(0, e));
    rest = rest.slice(e).replace(/^[.;]\s*/, '');
  }
}

/** Removes a trailing day/zone time; a clause with a warning is never touched, so its qualifier ("until Mon 7 PM") stays. */
function stripTime(s: string): string {
  return WARNING.test(s) ? s : s.replace(TRAILING_TIME, '').replace(TIME_ONLY, '');
}

/**
 * Cuts boilerplate such as "merges after Reviewer ..." from its match to the end of the clause. If that tail contains a
 * warning ("... merges after review but hold if CI is red") the clause is left whole: carving a warning out of its
 * sentence could reverse its meaning ("no need to hold"), and the whole clause is always safe to show.
 */
function dropBoiler(s: string, re: RegExp): string {
  const m = re.exec(s);
  if (!m || WARNING.test(m[0])) return s;
  return s.slice(0, m.index);
}

/** Drops merge boilerplate and a trailing day/zone time from one clause. */
function clean(s: string): string {
  const start = s;
  s = stripTime(s);
  s = dropBoiler(s, /\s+[A-Z][a-z]+[A-Z]\w*\s+merges\s+(?:after|at|on|when)\b.*$/);
  s = dropBoiler(s, /(?:^|\s+)merges\s+(?:after|at|on|when)\b.*$/i);
  s = stripTime(s);
  if (s !== start) s = s.replace(/\s+(?:to|by|until|before|after)$/i, ''); // only the leftover of removed boilerplate
  // A dangling "merges" left by removed boilerplate; never from a plain title ("Fix squash merge") or a warning ("Do not merge").
  if (s !== start && !WARNING.test(s)) s = s.replace(/\s+merges?$/i, '');
  return s.replace(/[\s,;:.\u2013\u2014-]+$/, '').trim();
}

function cap(s: string, max = MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '')}\u2026`;
}

/**
 * The cap must not hide a warning, and a warning alone never says what the merge is. If cutting would lose one, show
 * "<sign> <the warning's clause, with a little lead-in so a negation stays attached> \u00b7 <the start of the note>".
 */
function capKeepingWarning(s: string): string {
  const c = cap(s);
  if (!WARNING.test(s) || WARNING.test(c)) return c;
  const m = WARNING.exec(s)!;
  const before = s.slice(0, m.index);
  let start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('; '), before.lastIndexOf(', '), before.lastIndexOf(' - '));
  start = start >= 0 ? start + (s.startsWith(' - ', start) ? 3 : 2) : 0;
  if (m.index - start > 20) start = before.indexOf(' ', m.index - 20) + 1;
  const warnEnd = Math.max(start + 40, m.index + m[0].length);
  const warn = s.slice(start, warnEnd).replace(/[\s,;:]+$/, '') + (warnEnd < s.length ? '\u2026' : '');
  const room = Math.max(15, MAX - warn.length - 5);
  return `\u26a0 ${warn} \u00b7 ${cap(s, room)}`;
}

export type Summary = {
  headline: string;
  /**
   * The headline is not the whole note. Mechanical, not a judgement about what is safe to drop: true whenever the
   * normalised note (minus only its leading "Merge #N" / "PR #N") differs from the normalised headline, so any cut
   * (boilerplate, a time, a parenthetical, a clause, the cap, the 2000-character bound) says "more".
   */
  more: boolean;
};

const norm = (x: string) => x.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim();
// Only the first "Merge #N" / "PR #N" (and its separator): anything after it counts as content.
const FIRST_PREFIX = /^(?:(?:merge|pr)\s*)*#\d+\b\s*(?:[:\u2013\u2014]|-(?=\s))?\s*/i;

/**
 * @param pr the PR number of the row, if it has one. When the note names a different #N, that number is kept in the
 * headline so an agent's typo stays visible.
 */
export function summarizeMergeDetail(text: string, pr?: number | null): Summary {
  // Bound the work: a headline never needs more than the start of the note (and stripParens is quadratic on deep nesting).
  const original = text.slice(0, 2000).replace(/\s+/g, ' ').trim();
  const lead = LEADING_MERGE.exec(original)?.[0] ?? '';
  const named = [...lead.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const wrong = pr != null ? named.find((n) => n !== pr) : undefined;
  let s = stripParens(original.slice(lead.length));
  s = s.replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').replace(/^[\s:\u2013\u2014-]+/, '').trim();
  s = stripTime(s); // before the clause cut, so "Mon. 7 PM" is not split at "Mon."
  const [first = '', ...rest] = clauses(s).map(clean);
  s = [first, ...rest.filter((c) => WARNING.test(c))].filter(Boolean).join('. ');
  // Nothing meaningful left (empty, or only a leftover "merge"): show the whole note. A lone leftover word (an agent
  // name before "merges after ...") is no headline either.
  const lone = s !== original && !/\s/.test(s) && /\bmerges\s+(?:after|at|on|when)\b/i.test(original);
  const dangling = s !== original && (new RegExp(`^${DAYS}$`, 'i').test(s) || /\s(?:for|at|on|by|to)$/i.test(s));
  const whole = !s || lone || dangling || /^(?:merges?|pr|at|on|@)$/i.test(s);
  const body = whole ? original : s;
  const headline = capKeepingWarning(body);
  const shown = norm(headline);
  const more = shown !== norm(text.replace(FIRST_PREFIX, '')) && shown !== norm(text);
  return { headline: wrong !== undefined && body !== original ? `(note says #${wrong}) ${headline}` : headline, more };
}

export function summarizeMerge(text: string, pr?: number | null): string {
  return summarizeMergeDetail(text, pr).headline;
}
