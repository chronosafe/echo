import os from 'node:os';
import path from 'node:path';

export type MergeInvocation = {
  target: string | null;
  repoFlag: string | null;
  envRepo: string | null;
  cwd: string;
  auto: boolean;
  admin: boolean;
  disableAuto: boolean;
};

export type ParseResult =
  | { kind: 'none' }
  | { kind: 'merge'; inv: MergeInvocation }
  | { kind: 'ambiguous'; why: string };

// The parser is an allow-list. A command that might run `gh pr merge` is
//   - `merge`  only if it matches the strict merge grammar (tryMerge),
//   - `none`   only if it matches the strict mention grammar (isHarmlessMention),
//   - otherwise `ambiguous`.
//
// Threat model: this guard stops a cooperating agent from merging by accident. It does not stop
// deliberate obfuscation such as `m$(printf erge)`, a merge hidden in a script file, a `gh` alias,
// or a command assembled at runtime, and it never could. A command "might run gh pr merge" when
//   - its text has the phrase `gh pr merge` (NORM_PHRASE),
//   - or one of its pieces (mergePiece: the text split on ; && || | & and newlines) holds a `gh`
//     word whose subcommand (the first word past flags and their values) is `pr` and whose `pr`
//     subcommand is `merge`, wherever the gh word sits (`$(gh -R o/n pr merge 5)`, `timeout 9 gh ...`,
//     `xargs gh ...`, `bash -c 'gh ...'`). Text in an argument (`gh pr create --title "PR merge guard"`,
//     `gh issue comment 3 --body "blocked on PR merge"`) is not one. Or a `gh` word whose subcommand
//     is `api`, in a piece with a `pulls/N/merge` path (a read-only GET is refused too) or the
//     `mergePullRequest` or `enablePullRequestAutoMerge` mutation,
//   - or a segment's command word is an expansion or gh options placed before pr (classify).
// Other `gh api` forms are not seen.

type Word = {
  text: string;
  raw: string;
  quoted: boolean;
  singleOnly: boolean;
  /** An unquoted `$`, backtick, glob character, brace or parenthesis. */
  special: boolean;
  /** Contains an unquoted `<` or `>`, even if other parts of the word are quoted. */
  redirect: boolean;
  start: number;
  end: number;
};
type Sep = '' | '&&' | '||' | ';' | '\n' | '|' | '&';
type Segment = { sep: Sep; words: Word[] };
type Tokens = {
  segments: Segment[];
  unterminated: boolean;
  /** An unquoted `( ) { }`. */
  grouping: boolean;
  /** An unquoted newline that is not a backslash continuation. */
  newline: boolean;
  /** A lone `&` (background) operator. */
  background: boolean;
};

const NORM_PHRASE = /(^|[^a-z0-9_])gh\s+pr\s+merge\b/;
const NORM_PHRASE_G = /(^|[^a-z0-9_])gh\s+pr\s+merge\b/g;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!']);
const WRAPPERS = new Set(['time', 'sudo', 'env', 'command', 'nohup', 'exec']);
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-C', '-U']);
const SINKS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'less', 'more', 'cat', 'grep', 'cut']);
const SHORT_VALUE = new Set(['R', 'b', 't', 'A', 'F']);
const SHORT_BOOL = new Set(['d', 's', 'm', 'r']);
const LONG_VALUE = new Set(['--repo', '--body', '--body-file', '--subject', '--author-email', '--match-head-commit']);
const LONG_BOOL = new Set(['--admin', '--auto', '--disable-auto', '--delete-branch', '--merge', '--rebase', '--squash']);
const REDIRECTS = new Set(['2>&1', '>/dev/null', '2>/dev/null', '&>/dev/null']);
const REDIRECT_OPS = new Set(['>', '2>', '>>']);
const GENERIC_WHY = 'only `cd DIR && gh pr merge ...` chains are checked; run the merge as its own command';
const PIECE_WHY =
  'gh pr merge is reached in a form this hook cannot read (behind another command such as timeout or xargs, inside $( ) or backticks, or with gh options before pr); ' + GENERIC_WHY;
const API_WHY ='a gh api call to a pull request merge endpoint is not checked by this hook; use gh pr merge as its own command';
/** A REST merge endpoint path, `.../pulls/N/merge`, in normalised text. */
const PULLS_MERGE = /(^|[^a-z0-9_.-])pulls\/[^/\s]+\/merge(?![a-z0-9_-])/;
/** A GraphQL mutation that merges a pull request or turns on its auto-merge, in normalised text. */
const MERGE_MUTATION = /(^|[^a-z0-9_])(mergepullrequest|enablepullrequestautomerge)(?![a-z0-9_])/;

/** Remove quotes and backslashes, flatten whitespace, lowercase: what the shell would see as words. */
function normalise(s: string): string {
  return s.replace(/['"\\]/g, '').replace(/\s+/g, ' ').toLowerCase();
}

function tokenize(raw: string): Tokens {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let lead: Sep = '';
  let cur: { text: string; quoted: boolean; sawPlain: boolean; sawSingle: boolean; special: boolean; redirect: boolean; start: number } | null = null;
  let unterminated = false;
  let grouping = false;
  let newline = false;
  let background = false;

  const endWord = (i: number) => {
    const c = cur;
    if (c) {
      words.push({
        text: c.text,
        raw: raw.slice(c.start, i),
        quoted: c.quoted,
        singleOnly: c.sawSingle && !c.sawPlain,
        special: c.special,
        redirect: c.redirect,
        start: c.start,
        end: i,
      });
      cur = null;
    }
  };
  const endSegment = (i: number) => {
    endWord(i);
    const pushed = words.length > 0;
    if (pushed) {
      segments.push({ sep: lead, words });
      lead = '';
    }
    words = [];
    return pushed;
  };
  const begin = (i: number) => (cur ??= { text: '', quoted: false, sawPlain: false, sawSingle: false, special: false, redirect: false, start: i });

  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'") {
      const w = begin(i);
      w.quoted = true;
      w.sawSingle = true;
      const close = raw.indexOf("'", i + 1);
      if (close === -1) {
        unterminated = true;
        w.text += raw.slice(i + 1);
        i = raw.length;
      } else {
        w.text += raw.slice(i + 1, close);
        i = close + 1;
      }
    } else if (c === '"') {
      const w = begin(i);
      w.quoted = true;
      w.sawPlain = true;
      i++;
      let closed = false;
      while (i < raw.length) {
        const d = raw[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < raw.length && '"\\$`\n'.includes(raw[i + 1])) {
          if (raw[i + 1] !== '\n') w.text += raw[i + 1];
          i += 2;
          continue;
        }
        w.text += d;
        i++;
      }
      if (!closed) unterminated = true;
    } else if (c === '\\') {
      if (raw[i + 1] === '\n') {
        i += 2;
        continue;
      }
      const w = begin(i);
      w.quoted = true;
      w.sawPlain = true;
      w.text += raw[i + 1] ?? '';
      i += 2;
    } else if (c === '\n' || c === ';') {
      if (c === '\n') newline = true;
      const pushed = endSegment(i);
      // A separator after an operator (`|` then newline) must not erase the operator.
      if (pushed || lead === '') lead = c === '\n' ? '\n' : ';';
      i++;
    } else if (c === '&' && ((cur && /[<>]$/.test((cur as { text: string }).text)) || raw[i + 1] === '>')) {
      const w = begin(i);
      w.sawPlain = true;
      w.text += c;
      i++;
    } else if (c === '&' || c === '|') {
      endSegment(i);
      if (raw[i + 1] === c) {
        lead = c === '&' ? '&&' : '||';
        i += 2;
      } else {
        if (c === '&') background = true;
        lead = c === '&' ? '&' : '|';
        i += c === '|' && raw[i + 1] === '&' ? 2 : 1;
      }
    } else if (c === ' ' || c === '\t') {
      endWord(i);
      i++;
    } else if (c === '#' && !cur) {
      const nl = raw.indexOf('\n', i);
      i = nl === -1 ? raw.length : nl;
    } else {
      if ('(){}'.includes(c)) grouping = true;
      const w = begin(i);
      w.sawPlain = true;
      if ('$`*?[{}()'.includes(c)) w.special = true;
      if (c === '<' || c === '>') w.redirect = true;
      w.text += c;
      i++;
    }
  }
  endSegment(raw.length);
  return { segments, unterminated, grouping, newline, background };
}

/**
 * Words of a segment from the real command word on. Skipped in front of it: VAR=value assignments
 * (the name part must be unquoted), shell keywords (`do`, `then`, `!` ...) and wrapper commands
 * (`time`, `sudo`, `env` ...), so `sudo gh -R o/n pr ...` is classified as gh. An `$((` that opens
 * in an assignment or as a word, or a `((` arithmetic command, is arithmetic the tokenizer split on
 * spaces: its words up to the closing `))` are skipped too, and if it never closes they are no
 * command unless a literal pr or merge is among them. Wrappers this does not model (`timeout`,
 * `xargs`, `sudo --user bob` ...) are left to mergePiece.
 */
function commandWords(seg: Segment): { assigns: Word[]; rest: Word[] } {
  const ws = seg.words;
  let k = 0;
  while (k < ws.length) {
    const w = ws[k];
    if ((/\$\(\([^)]*$/.test(w.raw) && (ASSIGN.test(w.raw) || /^\$\(\(/.test(w.raw))) || /^\(\([^)]*$/.test(w.raw)) {
      // Count `((` against `))` so a nested `$(( 1 )) + 2 ))` does not close the outer one early.
      const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;
      let depth = count(w.raw, /\(\(/g) - count(w.raw, /\)\)/g);
      let c = k + 1;
      for (; c < ws.length; c++) {
        depth += count(ws[c].raw, /\(\(/g) - count(ws[c].raw, /\)\)/g);
        if (depth <= 0) break;
      }
      if (c >= ws.length) {
        const tail = ws.slice(k + 1);
        return { assigns: ws.slice(0, k), rest: tail.some((x) => lit(x, 'pr') || lit(x, 'merge')) ? tail : [] };
      }
      // A command substitution inside the arithmetic is run by the shell: keep its words.
      // Start at the first word that holds a substitution (the opener word itself in `$(($(gh ...`).
      const span = ws.slice(k, c + 1);
      const sub = span.findIndex((x) => /\$\((?!\()|`/.test(x.raw));
      if (sub !== -1 && span.some((x) => lit(x, 'pr') || lit(x, 'merge'))) {
        return { assigns: ws.slice(0, k), rest: span.slice(sub) };
      }
      k = c + 1;
    } else if (WRAPPERS.has(w.raw)) {
      k++;
      // the wrapper's own options (`sudo -E`, `env -i`, `time -p`, `sudo -u bob`) are not the command
      while (k < ws.length && !ws[k].quoted && ws[k].raw.startsWith('-')) k += WRAPPER_VALUE_FLAGS.has(ws[k].raw) ? 2 : 1;
    } else if (ASSIGN.test(w.raw) || LEADING_KEYWORDS.has(w.raw)) k++;
    else break;
  }
  return { assigns: ws.slice(0, k), rest: ws.slice(k) };
}

const isGh = (w: Word | undefined): boolean => !!w && !w.special && path.basename(w.text).toLowerCase() === 'gh';
const lit = (w: Word | undefined, t: string): boolean => !!w && !w.special && w.text.toLowerCase() === t;

/**
 * True when the command text, as the shell would see its words, contains the standalone word
 * `merge`. Words are split on characters outside [a-z0-9_./-], so `merge-base`, `mergeable` and
 * `--match-head-commit` do not count, while `merge` inside quotes, $( ) or backticks does. A
 * `pulls/N/merge` API path counts too; other paths ending in `/merge` (`docs/merge`, a branch
 * `fix/merge`) do not.
 */
function hasMergeWord(raw: string): boolean {
  const n = normalise(raw);
  return PULLS_MERGE.test(n) || n.split(/[^a-z0-9_./-]+/).some((t) => t === 'merge');
}

/**
 * For each index j of a word list, the index of the first word from j on that is not a flag:
 * walk past each word starting with `-` and, for a flag, the word after it as its value, unless
 * that word is a flag itself or is `merge`. Built backwards in one pass, so it stays linear. The
 * array has ws.length + 1 entries; ws.length means none.
 */
function firstPlainTable<T>(ws: T[], flag: (w: T) => boolean, merge: (w: T) => boolean): number[] {
  const plain = new Array<number>(ws.length + 1).fill(ws.length);
  for (let j = ws.length - 1; j >= 0; j--) {
    if (!flag(ws[j])) plain[j] = j;
    else if (j + 1 < ws.length && !flag(ws[j + 1]) && !merge(ws[j + 1])) plain[j] = plain[j + 2];
    else plain[j] = plain[j + 1];
  }
  return plain;
}

/**
 * The broad piece rule. Split the command on ; && || | & and newlines (after joining backslash
 * continuations), normalise each piece and split it into words as hasMergeWord does, except that
 * `$ { }` are word characters (so `${OWNER}/${REPO}` and `"$O/$R"` are one flag value), a gh word
 * may be written `$GH` or `${GH}`, and a `$( )` or backtick substitution with no gh word inside
 * counts as one word (so `-R $(cat f)` is one flag value). A piece is
 * a merge candidate ('pr') when a word whose basename is `gh` has `pr` as its subcommand and that
 * `pr` has `merge` as its subcommand, each being the first word past flags and their values
 * (firstPlainTable; a value is not skipped when it is `pr` or `merge`). So `gh pr -R o/n merge`,
 * `gh --repo o/n pr --squash merge` and `gh -R ${O}/${R} pr merge` count, while
 * `gh pr create --title "PR merge guard"` and `gh pr list --search merge` do not. The gh word may
 * sit anywhere in the piece: inside `$( )` or backticks, after `timeout 9`, `xargs`,
 * `sudo --user bob`, `bash -c '...'` or a case pattern. It is a candidate ('api') when a gh word has
 * `api` as its subcommand and the piece has a `pulls/N/merge` path or the `mergePullRequest` or
 * `enablePullRequestAutoMerge` GraphQL mutation. Splitting first keeps
 * `gh -R o/n pr view 5 && git merge x` out.
 */
function mergePiece(raw: string): 'pr' | 'api' | null {
  for (const piece of raw.replace(/\\\n/g, '').split(/[;&|\n]/)) {
    const p = normalise(piece);
    // `$ { }` are word characters here, so a flag value such as ${OWNER}/${REPO} or "$O/$R" is one
    // word, and a $( ) or backtick substitution with no gh word inside is one word (`-R $(cat f)`)
    const words = (s: string) => s.split(/[^a-z0-9_./${}-]+/).filter(Boolean);
    const isGhWord = (t: string) => path.basename(t.replace(/[${}]/g, '')) === 'gh';
    const ws = words(p.replace(/\$\([^()`]*\)|`[^`]*`/g, (m) => (words(m).some(isGhWord) ? m : '$x')));
    if (!ws.some(isGhWord)) continue;
    // a flag's value is skipped unless it is a flag, `pr` or `merge`
    const plain = firstPlainTable(ws, (t) => t.startsWith('-'), (t) => t === 'pr' || t === 'merge');
    for (let i = 0; i < ws.length; i++) {
      if (!isGhWord(ws[i])) continue;
      const sub = ws[plain[i + 1]];
      if (sub === 'pr' && ws[plain[plain[i + 1] + 1]] === 'merge') return 'pr';
      if (sub === 'api' && (PULLS_MERGE.test(p) || MERGE_MUTATION.test(p))) return 'api';
    }
  }
  return null;
}

/**
 * For each index j of ws, whether a walk from j (just after a literal `pr`) over flags, the plain
 * word that may follow each flag as its value, and expansions, up to the first plain word (the
 * subcommand), meets an expansion: the subcommand slot may be one. Built backwards in one pass,
 * so a command with many `pr` words stays linear. The array has ws.length + 1 entries.
 */
function subcommandSlotTable(ws: Word[]): boolean[] {
  const slot = new Array<boolean>(ws.length + 1).fill(false);
  for (let j = ws.length - 1; j >= 0; j--) {
    const w = ws[j];
    if (w.special) slot[j] = true;
    else if (!w.text.startsWith('-')) slot[j] = false;
    // a plain word after a flag may be its value, but an expansion there may be the subcommand
    else if (j + 1 < ws.length && !ws[j + 1].text.startsWith('-')) slot[j] = ws[j + 1].special || slot[j + 2];
    else slot[j] = slot[j + 1];
  }
  return slot;
}

/**
 * Index in `later` just past the word that closes the command word's own `$(` (the tokenizer
 * splits `$(which npm)` into `$(which` and `npm)`), or 0 when the command word is not a `$(` or it
 * does not close.
 */
function ownSubstitutionEnd(c: Word, later: Word[]): number {
  if (!/^\$\((?!\()/.test(c.raw)) return 0;
  const net = (t: string) => (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
  let depth = net(c.raw);
  let j = 0;
  while (depth > 0 && j < later.length) depth += net(later[j++].raw);
  return depth > 0 ? 0 : j;
}

/**
 * Candidate by expansion or by gh options placed before the subcommand. Returns why, or null.
 *
 * See the threat model at the top of the file. An expansion command word (`$GH`, `$(which gh)`)
 * makes the command a merge candidate only when it is followed by a literal `pr` word, which is
 * the subcommand slot (`$GH pr $M` stays refused), or when the text contains the standalone word
 * `merge` (mergeWord) and another expansion or `merge` follows the command word's own `$( )`.
 * Without that, `$(date ...) - $(date ...)`, `[ $? -ne 0 ]`, `date $(..) $(..)` and
 * `$(which npm) test` are ordinary shell. This relaxation accepts that a merge spelled without
 * the word `merge` anywhere is not seen. `gh` options before `pr` (`gh -R o/n pr ...`) are a
 * candidate when the subcommand slot may be an expansion or its first word past flags is `merge`;
 * with no literal `pr`, when mergeWord holds and `merge` or an expansion follows. The test
 * commands `[` and `[[` cannot run gh: they are candidates only when a literal `pr` comes after a
 * `gh` word or an expansion anywhere earlier inside them, and the slot after it may be an
 * expansion or is `merge` (`[ $($GH pr $A 5) ]`, `[ $(gh -R o/n pr $SUB 5) ]`), so
 * `[ $(gh pr view 5 ...) = OPEN ]` is not. A literal merge inside them is left to mergePiece.
 */
function classify(rest: Word[], mergeWord: boolean): string | null {
  const c = rest[0];
  if (!c) return null;
  const later = rest.slice(1);
  // the slot after a literal pr at i may be an expansion, or its first word past flags is merge
  const slotHit = (i: number, slot: boolean[], plain: number[]) => slot[i + 1] || lit(later[plain[i + 1]], 'merge');
  const tables = (): [boolean[], number[]] => [
    subcommandSlotTable(later),
    firstPlainTable(later, (w) => w.text.startsWith('-'), (w) => lit(w, 'merge')),
  ];
  if (!c.quoted && (c.text === '[' || c.text === '[[')) {
    const [slot, plain] = tables();
    let seen = false; // a gh word or an expansion earlier inside the brackets
    let hit = false;
    for (let i = 0; i < later.length && !hit; i++) {
      if (seen && lit(later[i], 'pr') && slotHit(i, slot, plain)) hit = true;
      if (isGh(later[i]) || later[i].special) seen = true;
    }
    return hit ? 'a test command contains gh pr with a subcommand that is an expansion or merge' : null;
  }
  if (isGh(c)) {
    if (lit(later[0], 'pr')) {
      if (later[1] && (later[1].special || later[1].text.startsWith('-'))) {
        return 'the gh pr subcommand is not a plain word this hook can read';
      }
      return null;
    }
    const first = later[0];
    if (!first || !(first.special || first.text.startsWith('-'))) return null;
    const [slot, plain] = tables();
    const hasPr = later.some((w) => lit(w, 'pr'));
    const hit = hasPr ? later.some((w, i) => lit(w, 'pr') && slotHit(i, slot, plain)) : mergeWord && later.some((w) => lit(w, 'merge') || w.special);
    return hit ? 'gh options before the subcommand cannot be parsed reliably; write gh pr merge first and put -R after it' : null;
  }
  if (c.special) {
    const after = later.slice(ownSubstitutionEnd(c, later));
    if (later.some((w) => lit(w, 'pr')) || (mergeWord && after.some((w) => lit(w, 'merge') || w.special))) {
      return 'the command word is a shell expansion followed by pr, merge or another expansion';
    }
  }
  return null;
}

type Fail = { why: string };
const fail = (why: string): Fail => ({ why });

function parseFlags(args: Word[], inv: MergeInvocation): Fail | null {
  const seen = new Set<string>();
  let positional = false;
  const valueOf = (j: number, attached: string | null): { v: string; next: number } | Fail => {
    if (attached !== null) return { v: attached, next: j };
    const w = args[j + 1];
    if (!w) return fail('a flag of gh pr merge is missing its value');
    if (w.special || /[`$]/.test(w.text) || w.redirect) return fail('a flag value contains a shell expansion or redirection');
    return { v: w.text, next: j + 1 };
  };
  const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const a = w.text;
    // redirections: only a few stand-alone forms
    if (w.redirect) {
      if (!w.quoted && REDIRECTS.has(a)) continue;
      if (!w.quoted && REDIRECT_OPS.has(a)) {
        const f = args[j + 1];
        if (!f || f.quoted || f.redirect || !/^[A-Za-z0-9_./-]+$/.test(f.text)) return fail('a redirection of the merge command is not one this hook can read');
        j++;
        continue;
      }
      return fail('the merge command has a redirection this hook cannot read');
    }
    if (w.special) return fail('the merge command contains a shell expansion or glob');
    if (w.quoted && a.startsWith('-')) return fail('a flag of gh pr merge is quoted');
    if (a === '--' ) return fail('-- in gh pr merge is not supported');
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (LONG_BOOL.has(name)) {
        if (eq !== -1) return fail(`${name} is written with =value`);
        if (seen.has(name)) return fail(`${name} is repeated`);
        seen.add(name);
        if (name === '--admin') inv.admin = true;
        else if (name === '--auto') inv.auto = true;
        else if (name === '--disable-auto') inv.disableAuto = true;
      } else if (LONG_VALUE.has(name)) {
        const r = valueOf(j, eq === -1 ? null : a.slice(eq + 1));
        if ('why' in r) return r;
        j = r.next;
        if (name === '--repo') {
          if (!REPO.test(r.v)) return fail('--repo must look like owner/name');
          inv.repoFlag = r.v;
        }
      } else return fail(`${name} is not a flag this hook knows`);
    } else if (a.startsWith('-') && a.length > 1) {
      const first = a[1];
      if (SHORT_VALUE.has(first)) {
        const r = valueOf(j, a.length > 2 ? a.slice(2).replace(/^=/, '') : null);
        if ('why' in r) return r;
        j = r.next;
        if (first === 'R') {
          if (!REPO.test(r.v)) return fail('-R must look like owner/name');
          inv.repoFlag = r.v;
        }
      } else if (![...a.slice(1)].every((ch) => SHORT_BOOL.has(ch))) {
        return fail(`the short flag group ${a} is not one this hook can read`);
      }
    } else if (w.quoted || !/^[A-Za-z0-9_./:#-]+$/.test(a)) {
      return fail('the merge target is not a plain number, branch or URL');
    } else if (positional) {
      return fail('gh pr merge has more than one positional argument');
    } else {
      inv.target = a;
      positional = true;
    }
  }
  if (inv.auto && inv.disableAuto) return fail('--auto and --disable-auto are combined');
  return null;
}

function cdDir(seg: Segment, cwd: string): { dir: string } | Fail {
  if (seg.words.length !== 2) return fail('a cd before gh pr merge must be exactly `cd DIR`');
  const w = seg.words[1];
  if (w.text.startsWith('-') || w.text.startsWith('+')) return fail('cd before gh pr merge takes an option-like argument');
  if (w.quoted) {
    if (/[$`\\]/.test(w.raw)) return fail('cd before gh pr merge goes somewhere this hook cannot resolve');
    return { dir: path.resolve(cwd, w.text) };
  }
  if (!/^[A-Za-z0-9_./@+~-]+$/.test(w.text) || w.text === '-') {
    return fail('cd before gh pr merge goes somewhere this hook cannot resolve');
  }
  let t = w.text;
  if (t.startsWith('~')) {
    if (t === '~' || t.startsWith('~/')) t = os.homedir() + t.slice(1);
    else return fail('cd ~user before gh pr merge cannot be resolved');
  }
  return { dir: path.resolve(cwd, t) };
}

function tryMerge(raw: string, tok: Tokens, cwd: string): { inv: MergeInvocation } | Fail {
  if (tok.unterminated) return fail('the command has an unterminated quote');
  if (tok.newline) return fail('the command has a newline; ' + GENERIC_WHY);
  if (tok.background) return fail('the command uses a background & operator; ' + GENERIC_WHY);
  if (tok.grouping) return fail('the command uses grouping or a subshell; ' + GENERIC_WHY);
  if (/`|\$\(|<<|\|&/.test(raw)) return fail('the command uses a substitution, heredoc or |&; ' + GENERIC_WHY);
  const segs = tok.segments;

  let m = 0;
  while (m < segs.length && segs[m].words[0].raw === 'cd') m++;
  if (m >= segs.length) return fail(GENERIC_WHY);
  for (let k = 1; k <= m; k++) {
    if (segs[k].sep !== '&&') return fail('cd before gh pr merge must be joined with && (a failed cd would merge from the old directory); ' + GENERIC_WHY);
  }

  let dir = cwd;
  for (let k = 0; k < m; k++) {
    const r = cdDir(segs[k], dir);
    if ('why' in r) return r;
    dir = r.dir;
  }

  const ms = segs[m];
  const words = ms.words;
  const inv: MergeInvocation = { target: null, repoFlag: null, envRepo: null, cwd: dir, auto: false, admin: false, disableAuto: false };
  let k = 0;
  if (ASSIGN.test(words[0].raw)) {
    const v = /^GH_REPO=(.*)$/.exec(words[0].text);
    if (!v || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v[1]) || /[$`\\]/.test(words[0].raw)) {
      return fail('the merge command sets an environment variable other than a plain GH_REPO=owner/name');
    }
    inv.envRepo = v[1];
    k = 1;
  }
  const bare = (w: Word | undefined, t: string) => !!w && !w.quoted && w.raw === t;
  if (!(bare(words[k], 'gh') && bare(words[k + 1], 'pr') && bare(words[k + 2], 'merge'))) {
    return fail(classify(commandWords(ms).rest, hasMergeWord(raw)) ?? GENERIC_WHY);
  }
  const bad = parseFlags(words.slice(k + 3), inv);
  if (bad) return bad;

  // After the merge: harmless sinks, then anything joined by && ; ||, as long as it is not another merge.
  let n = m + 1;
  while (n < segs.length && segs[n].sep === '|') {
    const c = segs[n].words[0];
    if (c.quoted || !SINKS.has(c.text)) return fail('the merge output is piped into a command other than head, tail, wc, sort, uniq, less, more, cat, grep or cut');
    n++;
  }
  for (let q = n; q < segs.length; q++) {
    if (segs[q].sep !== '&&' && segs[q].sep !== ';' && segs[q].sep !== '||') return fail('the merge is followed by a pipe or background operator this hook cannot read');
  }
  if (m + 1 < segs.length) {
    const tailRaw = raw.slice(segs[m + 1].words[0].start);
    if (NORM_PHRASE.test(normalise(tailRaw)) || mergePiece(tailRaw) || segs.slice(m + 1).some((s) => classify(commandWords(s).rest, true))) {
      return fail('the command contains more than one gh pr merge');
    }
  }
  return { inv };
}

const MENTION_CMDS = new Set(['echo', 'printf', 'grep', 'rg']);

/** A segment that can only print or search text: echo, printf, grep, rg or a plain `git commit`. */
function isMentionSegment(seg: Segment): boolean {
  const w = seg.words;
  if (ASSIGN.test(w[0].raw) || w[0].quoted) return false;
  const cmd = w[0].text;
  const flags = w.slice(1).filter((x) => !x.quoted && x.text.startsWith('-'));
  if (w.slice(1).some((x) => x.quoted && x.text.startsWith('-'))) return false;
  if (cmd === 'git') {
    if (!(w[1] && !w[1].quoted && w[1].raw === 'commit')) return false;
    return !flags.some((f) => /^-[A-Za-z]*[ecCF]/.test(f.text) && !f.text.startsWith('--') || /^--(edit|template|file|reuse-message|reedit-message|fixup|squash)/.test(f.text));
  }
  if (!MENTION_CMDS.has(cmd)) return false;
  if (cmd === 'printf') return !flags.some((f) => /^-[A-Za-z]*v/.test(f.text) && !f.text.startsWith('--'));
  if (cmd === 'rg') return !flags.some((f) => /^--(pre|hostname-bin)/.test(f.text));
  return true;
}

function isHarmlessMention(raw: string, tok: Tokens): boolean {
  if (tok.unterminated || tok.newline || tok.grouping) return false;
  if (raw.includes('<<')) return false;
  const segs = tok.segments;
  if (segs.some((s) => s.words.some((w) => w.redirect))) return false;

  const total = (normalise(raw).match(NORM_PHRASE_G) ?? []).length;
  if (total < 1 && !mergePiece(raw)) return false;

  let found = 0;
  const single: Word[] = []; // single-quoted mention arguments: blanked from scan
  const quoted: Word[] = []; // every quoted mention argument: blanked from unquoted
  // Blank the words' ranges (in ascending order) in one pass, so many quoted words stay linear.
  const blank = (s: string, ws: Word[]) => {
    const parts: string[] = [];
    let at = 0;
    for (const w of ws) {
      parts.push(s.slice(at, w.start), ' '.repeat(w.end - w.start));
      at = w.end;
    }
    parts.push(s.slice(at));
    return parts.join('');
  };
  let chain = false; // the previous segment was a mention or a sink fed by one
  for (const s of segs) {
    if (isMentionSegment(s)) {
      chain = true;
      for (const w of s.words.slice(1)) {
        if (!w.quoted) continue;
        const n = (normalise(w.text).match(NORM_PHRASE_G) ?? []).length;
        if (n > 0) {
          found += n;
          if (!w.singleOnly && /[$`]/.test(w.text)) return false;
        }
        if (w.singleOnly) single.push(w);
        quoted.push(w);
      }
      continue;
    }
    const c = s.words[0];
    if (chain && s.sep === '|' && !c.quoted && SINKS.has(c.text) && !ASSIGN.test(c.raw)) continue;
    return false;
  }
  if (/`|\$\(/.test(blank(raw, single))) return false;
  // with every quoted mention argument blanked, no merge piece may remain
  if (mergePiece(blank(raw, quoted))) return false;
  return found === total;
}

export function parseMerge(command: string, cwd: string): ParseResult {
  const control = /[\x00-\x08\x0b-\x1f\x7f]/.test(command);
  const raw = command.replace(/\s+$/, '');
  const tok = tokenize(raw);
  const mergeWord = hasMergeWord(raw);
  const expansionWhy = tok.segments.map((s) => classify(commandWords(s).rest, mergeWord)).find((w) => w);
  const piece = mergePiece(raw);
  const phrase = NORM_PHRASE.test(normalise(raw));
  if (!phrase && !expansionWhy && !piece) return { kind: 'none' };

  if (control) return { kind: 'ambiguous', why: 'the command contains a control character; ' + GENERIC_WHY };
  const r = tryMerge(raw, tok, cwd);
  if ('inv' in r) return { kind: 'merge', inv: r.inv };
  if (isHarmlessMention(raw, tok)) return { kind: 'none' };
  if (expansionWhy) return { kind: 'ambiguous', why: expansionWhy };
  if (piece === 'api') return { kind: 'ambiguous', why: API_WHY };
  return { kind: 'ambiguous', why: piece && !phrase && r.why === GENERIC_WHY ? PIECE_WHY : r.why };
}
