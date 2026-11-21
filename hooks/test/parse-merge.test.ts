import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMerge } from '../src/parse-merge';

const cases = [
  ['ls -la', '/w', { kind: 'none' }],
  ['gh pr merge', '/w', { kind: 'merge', inv: expect.objectContaining({ target: null, cwd: '/w' }) }],
  ['gh pr merge 709 --squash -d', '/w', { kind: 'merge', inv: expect.objectContaining({ target: '709' }) }],
  ['gh pr merge https://github.com/Acme/App/pull/5', '/w', { kind: 'merge', inv: expect.objectContaining({ target: 'https://github.com/Acme/App/pull/5' }) }],
  ['gh pr merge 5 -R acme/app', '/w', { kind: 'merge', inv: expect.objectContaining({ repoFlag: 'acme/app' }) }],
  ['gh pr merge 5 --repo=acme/app --auto', '/w', { kind: 'merge', inv: expect.objectContaining({ auto: true }) }],
  ['gh pr merge 5 --admin --squash', '/w', { kind: 'merge', inv: expect.objectContaining({ admin: true }) }],
  ['cd ../other && gh pr merge 5', '/w/x', { kind: 'merge', inv: expect.objectContaining({ cwd: '/w/other' }) }],
  ['GH_REPO=acme/app gh pr merge 5', '/w', { kind: 'merge', inv: expect.objectContaining({ envRepo: 'acme/app' }) }],
  ['gh pr merge 5 --disable-auto', '/w', { kind: 'merge', inv: expect.objectContaining({ disableAuto: true }) }],
  ['echo "run gh pr merge later"', '/w', { kind: 'none' }],
  ['git commit -m "gh pr merge after review"', '/w', { kind: 'none' }],
  ["bash -c 'gh pr merge 5'", '/w', { kind: 'ambiguous' }],
  ['gh pr merge 5 && gh pr merge 6', '/w', { kind: 'ambiguous' }],
  ['x=$(gh pr merge 5)', '/w', { kind: 'ambiguous' }],
] as const;

describe('parseMerge (brief table)', () => {
  it.each(cases)('%s', (cmd, cwd, expected) => expect(parseMerge(cmd, cwd)).toMatchObject(expected));
});

describe('parseMerge (more)', () => {
  it('an absolute cd replaces the cwd, and the last cd wins', () => {
    const r = parseMerge('cd /a/b && cd ../c && gh pr merge 5', '/w');
    expect(r).toMatchObject({ kind: 'merge', inv: { cwd: '/a/c' } });
  });
  it('a cd after the merge segment does not count', () => {
    expect(parseMerge('gh pr merge 5 && cd /elsewhere', '/w')).toMatchObject({ kind: 'merge', inv: { cwd: '/w' } });
  });
  it('cd with an unresolvable argument before a merge is ambiguous', () => {
    expect(parseMerge('cd ~user/x && gh pr merge 5', '/w').kind).toBe('ambiguous');
    expect(parseMerge('cd "$D" && gh pr merge 5', '/w').kind).toBe('ambiguous');
    expect(parseMerge('cd - && gh pr merge 5', '/w').kind).toBe('ambiguous');
  });
  it('a value after -R is not mistaken for the target; -Rvalue and --repo value work', () => {
    expect(parseMerge('gh pr merge -R acme/app 5', '/w')).toMatchObject({ kind: 'merge', inv: { target: '5', repoFlag: 'acme/app' } });
    expect(parseMerge('gh pr merge --repo acme/app', '/w')).toMatchObject({ kind: 'merge', inv: { target: null, repoFlag: 'acme/app' } });
    expect(parseMerge('gh pr merge 5 -Racme/app', '/w')).toMatchObject({ kind: 'merge', inv: { repoFlag: 'acme/app' } });
  });
  it('a body value that names a flag is not parsed as a flag', () => {
    expect(parseMerge('gh pr merge 5 --body "--admin"', '/w')).toMatchObject({ kind: 'merge', inv: { admin: false } });
  });
  it('quoted arguments and newlines split into segments correctly', () => {
    expect(parseMerge('echo hi\ngh pr merge 5', '/w').kind).toBe('ambiguous'); // moved: newline
    expect(parseMerge('gh pr merge 5 | cat', '/w').kind).toBe('merge');
    expect(parseMerge('false || gh pr merge 5', '/w').kind).toBe('ambiguous'); // moved: only cd may precede
  });
  it('merge flags default to false', () => {
    expect(parseMerge('gh pr merge 5', '/w')).toMatchObject({
      kind: 'merge',
      inv: { auto: false, admin: false, disableAuto: false, envRepo: null, repoFlag: null },
    });
  });
  it('a hidden merge reached through eval, xargs, backticks, sh -c is ambiguous', () => {
    for (const c of [
      'eval "gh pr merge 5"',
      'echo 5 | xargs gh pr merge',
      'echo `gh pr merge 5`',
      'sh -c "gh pr merge 5"',
      'bash -lc "gh pr merge 5"',
    ]) {
      expect(parseMerge(c, '/w').kind, c).toBe('ambiguous');
    }
  });
  it('a merge with $( or eval elsewhere in the command is ambiguous', () => {
    expect(parseMerge('gh pr merge $(cat n)', '/w').kind).toBe('ambiguous');
    expect(parseMerge('gh pr merge 5 && eval x', '/w').kind).toBe('merge'); // moved: text after the merge cannot change it
  });
  it('a merge hidden behind a wrapper or reordered gh words is ambiguous, not none', () => {
    expect(parseMerge('env GH_REPO=a/b gh pr merge 5', '/w').kind).toBe('ambiguous');
    expect(parseMerge('gh -R a/b pr merge 5', '/w').kind).toBe('ambiguous');
    expect(parseMerge('foo "gh pr merge 5"', '/w').kind).toBe('ambiguous');
  });
  it('a real merge next to a quoted mention is still the one merge', () => {
    expect(parseMerge('echo "gh pr merge" && gh pr merge 5', '/w').kind).toBe('ambiguous'); // moved: only cd may precede
  });
  it('an unquoted mention in echo is ambiguous (the exception is for quoted arguments only)', () => {
    expect(parseMerge('echo gh pr merge', '/w').kind).toBe('ambiguous');
  });
  it('quoted mentions under printf and grep are none', () => {
    expect(parseMerge("printf '%s\\n' 'gh pr merge 5'", '/w').kind).toBe('none');
    expect(parseMerge('grep "gh pr merge" file.txt', '/w').kind).toBe('none');
  });
  it("echo 'gh pr merge $(x)' is none: $( inside a single-quoted echo argument is inert", () => {
    expect(parseMerge("echo 'gh pr merge $(x)'", '/w').kind).toBe('none');
  });
  it('echo "gh pr merge $(x)" is ambiguous: double quotes still run the substitution', () => {
    expect(parseMerge('echo "gh pr merge $(x)"', '/w').kind).toBe('ambiguous');
  });
  it('a quoted echo mention followed by a pipe into xargs is ambiguous', () => {
    expect(parseMerge('echo "gh pr merge 5" | xargs sh', '/w').kind).toBe('ambiguous');
  });
  it('subshell grouping and a standalone GH_REPO assignment before a merge are ambiguous', () => {
    expect(parseMerge('(cd /a && gh pr merge 5)', '/w').kind).toBe('ambiguous');
    expect(parseMerge('export GH_REPO=a/b; gh pr merge 5', '/w').kind).toBe('ambiguous');
  });
  it('an unterminated quote with a merge mention is ambiguous', () => {
    expect(parseMerge('gh pr merge 5 "', '/w').kind).toBe('ambiguous');
  });
  it('commands without the phrase are none even when odd', () => {
    expect(parseMerge('eval "ls"; echo `date`', '/w').kind).toBe('none');
    expect(parseMerge('gh pr view 5', '/w').kind).toBe('none');
  });

  it('an unquoted leading ~ in cd expands to the home directory', () => {
    expect(parseMerge('cd ~/x && gh pr merge 5', '/w')).toMatchObject({ kind: 'merge', inv: { cwd: path.join(os.homedir(), 'x') } });
    expect(parseMerge('cd ~ && gh pr merge 5', '/w')).toMatchObject({ kind: 'merge', inv: { cwd: os.homedir() } });
  });
});

describe('parseMerge (review round 1: must be ambiguous, never none or a wrong merge)', () => {
  const ambiguous: [string, string?][] = [
    // Critical 1
    ['echo "gh pr merge 5" | sh'],
    ["grep 'gh pr merge' notes.txt | bash"],
    ['echo "gh pr merge 5" |& sh'],
    ['echo "gh pr merge 5" | head | sh'],
    ['GH pr merge 5'],
    ['Gh Pr Merge 5'],
    // Critical 2
    ['export GH_REPO="other/repo"; gh pr merge 5'],
    ['export "GH_REPO=x"; gh pr merge 5'],
    ["declare -x GH_REPO='x'; gh pr merge 5"],
    ['export GIT_DIR=/o/.git; gh pr merge 5'],
    ['GIT_WORK_TREE=/o; export GIT_WORK_TREE; gh pr merge 5'],
    ['GIT_DIR=/other/.git gh pr merge 5'],
    ['GH_HOST=h gh pr merge 5'],
    ['GH_CONFIG_DIR=/c gh pr merge 5'],
    ['GH_REPO=a/b GIT_DIR=/x gh pr merge 5'],
    ['gh pr merge 5 -dR other/repo'],
    ['gh pr merge 5 -dx'],
    ['gh pr merge 5 6'],
    ['gh pr merge 5 $EXTRA'],
    ['gh pr merge 5 *'],
    ['gh pr merge 5 ?'],
    ['gh pr merge 5 [a]'],
    ['gh pr merge 5 {a,b}'],
    ['gh pr merge 5 --auto=true'],
    ['gh pr merge 5 --admin=true'],
    ['gh pr merge 5 --disable-auto=false'],
    ['gh pr merge 5 --disable-auto --disable-auto'],
    ['gh pr merge 5 --disable-auto --auto'],
    // Important 3
    ["gh pr $'merge' 5"],
    ['gh pr {merge,} 5'],
    ['c=merge; gh pr $c 5'],
    ['g=gh; $g pr merge 5'],
    // Important 4
    ['cd /a | gh pr merge 5'],
    ['cd /a & gh pr merge 5'],
    ['cd /a || gh pr merge 5'],
    ['false && cd /a; gh pr merge 5'],
    ['false || cd /a; gh pr merge 5'],
    ['cd /a && cd /b; gh pr merge 5'],
    ['ls | cd /a && gh pr merge 5'],
    ['cat <<EOF\ncd /a\nEOF\ngh pr merge 5'],
    ['cat <<EOF\ngh pr merge 5\nEOF'],
    // kept from before
    ['gh -R x pr merge 5'],
    ['env GH_REPO=a/b gh pr merge 5'],
    ['cd - && gh pr merge 5'],
    ['cd $D && gh pr merge 5'],
  ];
  it.each(ambiguous)('%s', (cmd) => expect(parseMerge(cmd, '/w').kind).toBe('ambiguous'));

  it('says to put -R after pr merge for gh -R x pr merge', () => {
    expect(parseMerge('gh -R x pr merge 5', '/w')).toMatchObject({ kind: 'ambiguous', why: expect.stringContaining('put -R after') });
  });

  const nones = [
    'grep -rn "gh pr merge" hooks/ | head',
    'echo "gh pr merge 5" | wc -l',
    'gh pr view 5',
    'gh issue list --limit 5',
    '$g status',
    'ls $HOME',
  ];
  it.each(nones)('stays none: %s', (cmd) => expect(parseMerge(cmd, '/w').kind).toBe('none'));

  it('cd then merge still resolves when the cd is certain', () => {
    expect(parseMerge('cd /a && gh pr merge 5', '/w')).toMatchObject({ kind: 'merge', inv: { cwd: '/a' } });
    expect(parseMerge('ls && cd /a && gh pr merge 5', '/w').kind).toBe('ambiguous'); // moved: only cd may precede
    expect(parseMerge('cd /a\ngh pr merge 5', '/w').kind).toBe('ambiguous'); // moved: newline
    expect(parseMerge('cd /a; gh pr merge 5', '/w').kind).toBe('ambiguous'); // moved: ; after cd
  });

  it('redirections are stripped before parsing flags', () => {
    for (const c of ['gh pr merge 5 --squash 2>&1', 'gh pr merge 5 > out.txt', 'gh pr merge 5 2> err', 'gh pr merge 5 &>/dev/null', 'gh pr merge 5 >/dev/null', 'gh pr merge 5 2>/dev/null', 'gh pr merge 5 >> o 2>&1']) {
      expect(parseMerge(c, '/w'), c).toMatchObject({ kind: 'merge', inv: { target: '5' } });
    }
  });

  it('stand-alone redirection forms only; anything else is ambiguous', () => {
    for (const c of ['gh pr merge 5 < in', 'gh pr merge 5 &>log', 'gh pr merge 5 >out', 'gh pr merge 5 --admin>/dev/null', 'gh pr merge 5 2>&1 >']) {
      expect(parseMerge(c, '/w').kind, c).toBe('ambiguous');
    }
  });

  it('-R=o/r gives repoFlag o/r; a quoted GH_REPO value is accepted; known short clusters are fine', () => {
    expect(parseMerge('gh pr merge 5 -R=o/r', '/w')).toMatchObject({ kind: 'merge', inv: { repoFlag: 'o/r' } });
    expect(parseMerge('GH_REPO="o/r" gh pr merge 5', '/w')).toMatchObject({ kind: 'merge', inv: { envRepo: 'o/r' } });
    expect(parseMerge('gh pr merge 5 -ds', '/w')).toMatchObject({ kind: 'merge', inv: { target: '5' } });
    expect(parseMerge('gh pr merge 5 --body=hi --auto', '/w')).toMatchObject({ kind: 'merge', inv: { auto: true } });
  });
});

describe('parseMerge (review round 2: allow-list grammar)', () => {
  const ambiguous = [
    'echo "gh pr merge 5" |\nsh',
    'echo "gh pr merge 5" | # c\nsh',
    'cd /a &\ngh pr merge 5',
    'cd /a |\ngh pr merge 5',
    'echo gh pr "merge" 5 | sh',
    'command gh pr "merge" 5',
    'sudo gh "pr" merge 5',
    'gh pr "merge" 5',
    'gh "pr" merge 5',
    'gh pr merge 5 --admin>/dev/null',
    '{ cd /a; }; gh pr merge 5',
    'builtin cd /a && gh pr merge 5',
    'if true; then cd /a; fi; gh pr merge 5',
    '\\cd /a && gh pr merge 5',
    '"cd" /a && gh pr merge 5',
    'git checkout feat-b && gh pr merge 5',
    'gh repo set-default o/r && gh pr merge 5',
    'echo "gh pr merge 5" > m.sh && sh m.sh',
    'gh pr merge 5 --nope',
    'gh pr merge 5 -R notarepo',
    'gh pr merge 5 -- 6',
    'gh pr merge "5"',
    'gh pr merge 5 | sh',
    'gh pr merge 5 &',
    'gh pr merge 5 && gh pr merge 6',
    'gh pr merge 5 || gh "pr" merge 6',
    'cd "a b$c" && gh pr merge 5',
    'cd a b && gh pr merge 5',
    'echo "gh pr merge" ; c=merge; gh pr $c 5',
    'echo "gh pr merge" ; gh "pr" "merge" 5',
  ];
  it.each(ambiguous)('ambiguous: %j', (cmd) => expect(parseMerge(cmd, '/w').kind).toBe('ambiguous'));

  it('says what to change', () => {
    expect(parseMerge('git checkout x && gh pr merge 5', '/w')).toMatchObject({
      kind: 'ambiguous',
      why: expect.stringContaining('only `cd DIR && gh pr merge ...` chains are checked'),
    });
  });

  it('plain merges and cd chains still work', () => {
    expect(parseMerge('gh pr merge 5 --squash && git checkout main && git pull', '/w')).toMatchObject({ kind: 'merge', inv: { target: '5' } });
    expect(parseMerge('cd ~/repo && gh pr merge 5 --squash -d 2>&1', '/w')).toMatchObject({
      kind: 'merge',
      inv: { target: '5', cwd: path.join(os.homedir(), 'repo') },
    });
    expect(parseMerge('cd "my dir" && gh pr merge 5 --body "hello there" -R o/r', '/w')).toMatchObject({
      kind: 'merge',
      inv: { cwd: '/w/my dir', repoFlag: 'o/r' },
    });
    expect(parseMerge('gh pr merge 5 | head -n 3', '/w').kind).toBe('merge');
  });

  it('mentions stay none', () => {
    expect(parseMerge('grep -rn "gh pr merge" hooks/ | head', '/w').kind).toBe('none');
    expect(parseMerge("rg 'gh pr merge' src", '/w').kind).toBe('none');
    // banned words inside the quoted argument are text, not commands
    expect(parseMerge('git commit -m "gh pr merge after sh review"', '/w').kind).toBe('none');
  });
});

describe('parseMerge (review round 3)', () => {
  const ambiguous = [
    // redirection hidden behind a quoted piece of the word
    `echo 'gh pr merge 5' "">m.sh; chmod +x m.sh; ./m.sh`,
    `echo 'gh pr merge 5' ''>m.sh`,
    `gh pr merge 5 ""2>/dev/null`,
    // none-grammar is a pure allow-list
    `git -c 'alias.x=!gh pr merge 5 #' x commit`,
    `git -c core.editor=sh commit -e -m 'gh pr merge 5'`,
    `GIT_EDITOR=sh git commit -e -m 'gh pr merge 5'`,
    `git commit -e -m 'gh pr merge 5'`,
    `git commit -ae -m 'gh pr merge 5'`,
    `git commit --edit -m 'gh pr merge 5'`,
    `git commit --template=t -m 'gh pr merge 5'`,
    `git commit -F msg -m 'gh pr merge 5'`,
    `git commit -m 'gh pr merge 5' && awk '{system($0)}' .git/COMMIT_EDITMSG`,
    `printf -v c 'gh pr merge 5'; $c`,
    `printf -v c 'gh pr merge 5' && echo done`,
    `rg --pre sh 'gh pr merge' x`,
    `git add -A && git commit -m "gh pr merge after review"`,
    `echo "gh pr merge 5"; ls`,
    `echo "gh pr merge 5" | tee m.txt`,
    // control characters
    'gh pr merge 5 -b x\r# --admin',
    "printf '%s\\n' 'gh pr merge 5' \r# | sh",
    'gh pr merge 5\f',
    // cd chains
    'cd a; gh pr merge 5',
    'cd missing; cd ..; gh pr merge 5',
    'cd a && cd b; gh pr merge 5',
    'cd "-" && gh pr merge 5',
    "cd '-x' && gh pr merge 5",
    'cd -- && gh pr merge 5',
    'cd +0 && gh pr merge 5',
    'cd "+1" && gh pr merge 5',
  ];
  it.each(ambiguous)('ambiguous: %j', (cmd) => expect(parseMerge(cmd, '/w').kind).toBe('ambiguous'));

  it('cd a && cd b && gh pr merge gives cwd a/b', () => {
    expect(parseMerge('cd a && cd b && gh pr merge 5', '/w')).toMatchObject({ kind: 'merge', inv: { cwd: '/w/a/b' } });
  });

  it('plain mentions stay none', () => {
    for (const c of [
      'git commit -m "gh pr merge after review"',
      'git commit -am "gh pr merge after review"',
      'grep -rn "gh pr merge" hooks/ | head',
      'echo "x" && echo "gh pr merge 5"',
      "printf '%s\\n' 'gh pr merge 5' | wc -l",
    ]) expect(parseMerge(c, '/w').kind, c).toBe('none');
  });
});

describe('parseMerge (expansion command words need the word merge)', () => {
  const none = [
    "t=$(( $(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' 2026-11-19T23:20:00Z +%s) - $(date -u +%s) )); echo \"sleep $t\"; sleep $t; date -u +%TZ",
    "until gh pr checks 714 2>/dev/null | awk -F'\\t' '{print $2}' | grep -q pending; [ $? -ne 0 ]; do sleep 30; done; echo done",
    'for b in A B C; do git merge-base --is-ancestor $b origin/render && echo "$b ok"; done',
    'for b in A B; do git fetch origin $b; [ -n "$b" ] && git merge-base --is-ancestor $b origin/render; done',
    'git merge-base --is-ancestor $(git rev-parse HEAD) $(git rev-parse origin/render)',
    'echo mergeable $(date) $(date)',
    'gh -R o/n pr view 5',
    'gh -R o/n pr checks 5',
    'gh -R $REPO pr view 5',
    'time sleep $t && env FOO=$X git merge-base $A $B',
    'sudo gh -R o/n pr view 5',
    // the merge word elsewhere in the command must not condemn a test or arithmetic segment
    'git fetch origin && git merge --no-edit origin/render; [ $? -eq 0 ] || git merge --abort',
    'git commit -m "merge origin/render" && [ $? -eq 0 ] && echo ok',
    't=$(( $(date +%s) - $S )); echo "merge window in $t s"',
    "cd hooks && npx vitest run test/parse-merge.test.ts -t 'merge' && [ $? -eq 0 ]",
    'for p in 5; do [ $? -eq 0 ] && echo "merge $p"; done',
    'if [ $? -eq 0 ]; then echo merge; fi',
    // review round 4, finding 6: a test command that holds a plain gh pr subcommand is ordinary
    '[[ $(gh pr checks 5 --json state -q ".[].state" | sort -u) == SUCCESS ]] && echo ok',
    '[ $(gh pr view 5 --json state -q .state) = OPEN ] && echo open',
    'if [ "$KIND" = pr ]; then echo yes; fi',
    '[[ $kind == pr ]] && echo yes',
    // finding 7: the merge word in another piece does not condemn gh <opts> pr <plain subcommand>
    'gh -R o/n pr view 5 && git merge origin/main',
    'gh --repo o/n pr view 5 --json title -q .title | grep -i merge',
    // finding 8: only a pulls/N/merge path counts as a merge word; `((` is arithmetic
    'ls docs/merge && $(npm bin)/vitest run',
    'git checkout fix/merge && $(which npm) test',
    '(( n++ )) ; git merge --no-ff topic',
    'git checkout main && git merge feature && $(which npm) test',
    // a quoted mention of the new candidate forms is still a mention
    'git commit -m "hooks: gh -R handling for pr merge"',
    'git commit -m "docs: gh api repos/o/n/pulls/5/merge is refused"',
    // round 2: merge as text in an argument of another gh pr subcommand is not a merge
    'gh pr create --title "fix merge guard" --body "x"',
    'gh pr comment 5 --body "ready to merge"',
    'gh pr review 5 --approve --body "ok to merge"',
    'gh pr list --search "merge conflict"',
    'gh pr edit 5 --title "merge queue"',
    'gh -R o/n pr list --search "merge conflict"',
    'timeout 60 gh pr create --title "merge queue" --body x',
    'x=$(gh -R o/n pr view 5 --json title -q .title) && echo "$x" merge',
    // round 3: "PR merge" as free text; pr counts only as gh's subcommand
    'gh pr create --title "hooks: tighten PR merge guard" --body "x"',
    'gh pr create --title "Echo: block PR merge while held" --body "x"',
    'gh pr comment 5 --body "Ready for PR merge once CI is green"',
    'gh pr comment 5 --body "This PR: merge after CI"',
    'gh pr edit 5 --body "Fixes the PR merge check"',
    'gh pr review 5 --approve --body "LGTM. PR merge OK."',
    'gh pr list --search "is:pr merge"',
    'gh issue comment 3 --body "blocked on PR merge"',
    'gh issue create --title "PR merge fails when held" --body x',
    // round 3: api counts only as gh's subcommand
    'gh pr comment 5 --body "the api uses pulls/5/merge"',
    // round 3: a bare merge value of another subcommand's flag
    'gh pr list --search merge',
    'gh pr create --title merge',
  ];
  it.each(none)('none: %j', (cmd) => expect(parseMerge(cmd, '/w').kind).toBe('none'));

  const refused = [
    '$GH pr merge 5',
    '$(which gh) pr merge 5',
    'X=gh; $X pr merge 5',
    'cmd="gh pr merge 5"; $cmd',
    'for p in 5; do gh pr merge $p; done',
    // decision: a literal `pr` after an expansion command word stays refused (the subcommand slot)
    '$GH pr $M',
    '$GH pr view 5',
    'gh -R $REPO pr $SUB',
    'gh --repo o/n pr $SUB 5',
    'gh -R o/n pr -R o/n $SUB 5',
    'gh -R o/n pr --repo $R $SUB 5',
    'gh -R $R pr -R $R $SUB 5',
    'gh -R o/n pr --body x $SUB',
    '[ $(gh -R o/n pr merge 5) ]',
    '[ $($GH pr $A 5) ]',
    '[[ $($GH pr $A 5) ]]',
    'sudo gh -R o/n pr merge 5',
    'time gh -R o/n pr merge 5',
    'env gh -R o/n pr merge 5',
    'env A=1 B=2 gh -R o/n pr merge 5',
    'command gh -R o/n pr merge 5',
    'nohup gh -R o/n pr merge 5',
    'exec gh -R o/n pr merge 5',
    'time ${GH} pr merge 5',
    'X=$(( $(( 1 + 2 )) + 3 )) gh -R o/n pr merge 5',
    'x=$(( $(gh -R o/n pr merge 5) ))',
    '$(( $(gh -R o/n pr merge 5) ))',
    'x=$(( $(gh -R o/n pr view 5) + 1 ))',
    'x=$(( 1 + $(gh -R o/n pr merge 5) ))',
    'x=$(( 1 + 2 * $(gh -R o/n pr merge 5) ))',
    'x=$(($(gh -R o/n pr merge 5)))',
    'x=$(($(gh -R o/n pr merge 5) + 1))',
    'x=$(( `gh -R o/n pr merge 5` ))',
    'sudo -E gh -R o/n pr merge 5',
    'env -i gh -R o/n pr merge 5',
    'time -p gh -R o/n pr merge 5',
    'command -p gh -R o/n pr merge 5',
    'sudo -u bob gh -R o/n pr merge 5',
    'sudo -E $(echo gh) pr merge 5',
    'env -i $GH pr $A 5',
    'X=$(( 1 + 2 )) gh -R o/n pr merge 5',
    'gh -R o/n pr -- $SUB 5',
    'gh -R o/n pr --help $SUB 5',
    'gh -R o/n pr --web $SUB',
    'gh -R o/n pr -R $SUB 5',
    '$GH api -X PUT repos/$REPO/pulls/$N/merge',
    '$(which gh) api -X PUT repos/o/n/pulls/$PR/merge',
    'for p in 5; do $GH pr $ACT $p; done',
    'if true; then gh -R $R pr $SUB 5; fi',
    'while true; do $GH pr $ACT; done',
    'until $GH pr $ACT; do sleep 1; done',
    'true && ! $GH pr $ACT 5',
    't=$(( 1 + 2 )); $GH pr $ACT',
    't=$(( $($GH pr merge 5) ))',
    'X=gh; Y=merge; $X pr $Y 5',
    'A=pr; B=merge; gh $A $B 5',
    '$GH pr "me"rge 5',
    '`which gh` pr "merge" 5',
    '$(echo gh) $(echo pr) $(echo merge) 5',
    'gh $OPTS pr merge 5',
    'gh pr merge 5 && $X pr merge 6',
    'M=MERGE; $GH $P $M 5',
    // review round 4, finding 1: gh api merge endpoints
    'gh api -X PUT repos/o/n/pulls/5/merge',
    'gh api --method PUT repos/o/n/pulls/5/merge -f merge_method=squash',
    'gh api repos/o/n/pulls/5/merge -X PUT',
    'gh api -XPUT repos/o/n/pulls/5/merge',
    'gh api -X PUT /repos/o/n/pulls/5/merge',
    "gh api graphql -f query='mutation { mergePullRequest(...) }'",
    // finding 2: gh <opts> pr merge inside a command substitution
    'x=$(gh -R o/n pr merge 5)',
    'out=$(gh --repo o/n pr merge 5 --squash --delete-branch); echo "$out"',
    'x=`gh -R o/n pr merge 5`',
    'echo $(gh -R o/n pr merge 5)',
    'echo "$(gh -R o/n pr merge 5)"',
    '[ -n "$(gh -R o/n pr merge 5)" ]',
    // finding 3: wrapper commands
    'timeout 120 gh -R o/n pr merge 5 --squash',
    'echo 5 | xargs gh -R o/n pr merge',
    'nice -n 5 gh -R o/n pr merge 5',
    'caffeinate -i gh -R o/n pr merge 5',
    "bash -c 'gh -R o/n pr merge 5'",
    'eval gh -R o/n pr merge 5',
    'env -S "gh -R o/n pr merge 5"',
    // finding 4: wrapper option values and other prefixes
    'sudo --user bob gh -R o/n pr merge 5',
    'time -o t.txt gh -R o/n pr merge 5',
    'exec -a foo gh -R o/n pr merge 5',
    'builtin command gh -R o/n pr merge 5',
    'case x in x) gh -R o/n pr merge 5;; esac',
    // round 2: merge in the subcommand slot after pr flags, in any wrapper
    'gh pr -R o/n merge 5',
    'gh --repo o/n pr --squash merge 5',
    'gh pr -Ro/n merge 5',
    'gh pr --repo=o/n merge 5',
    'timeout 5 gh pr -R o/n merge 5',
    'x=$(gh pr --repo o/n merge 5)',
    "bash -c 'gh -R o/n pr -R o/n merge 5'",
    // round 3: ${ } and "$A/$B" flag values stay one word in the piece rule
    'gh -R ${OWNER}/${REPO} pr merge 5',
    'timeout 60 gh pr -R ${OWNER}/${REPO} merge 5',
    'timeout 60 gh pr --repo="$OWNER/$REPO" merge 5',
    'timeout 60 gh -R ${OWNER}/${REPO} pr merge 5',
    'timeout 5 gh -R $(cat repo) pr merge 5',
    'timeout 5 gh -R `cat repo` pr merge 5',
    'timeout 5 ${GH} -R o/n pr merge 5',
    'timeout 5 $GH pr -R o/n merge 5',
    // round 3: the GraphQL auto-merge mutation, and a mutation with no spaces
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(...) }'",
    "timeout 30 gh api graphql -f query='mutation{mergePullRequest(input:{})}'",
    // round 2, concern 2: gh or an expansion anywhere earlier inside the brackets
    '[ $(gh -R o/n pr $SUB 5) ]',
    '[[ $(gh --repo o/n pr -R o/n $SUB) ]]',
    // finding 9: a mis-closed arithmetic does not hide the command
    'X=$(( 1 + 2 ) ) gh -R o/n pr merge 5',
  ];
  it.each(refused)('not none: %j', (cmd) => expect(parseMerge(cmd, '/w').kind).not.toBe('none'));
  it('finding 5: a second merge behind a wrapper or gh api after a valid merge is ambiguous', () => {
    for (const c of [
      'gh pr merge 5 && timeout 5 gh -R o/n pr merge 6',
      'gh pr merge 5 && x=$(gh -R o/n pr merge 6)',
      'gh pr merge 5; gh api -X PUT repos/o/n/pulls/6/merge',
      'gh pr merge 5 && nice gh pr -R o/n merge 6',
    ]) expect(parseMerge(c, '/w').kind, c).toBe('ambiguous');
  });
  it('a piece-only or gh api refusal says what to do', () => {
    expect(parseMerge('timeout 120 gh -R o/n pr merge 5', '/w')).toMatchObject({ kind: 'ambiguous', why: expect.stringContaining('behind another command') });
    expect(parseMerge('gh api -X PUT repos/o/n/pulls/5/merge', '/w')).toMatchObject({ kind: 'ambiguous', why: expect.stringContaining('gh api') });
  });
  it('a read of a pull request through gh api is none', () => {
    expect(parseMerge('gh api repos/o/n/pulls/5', '/w').kind).toBe('none');
    expect(parseMerge('gh api repos/o/n/pulls/5/merges', '/w').kind).toBe('none');
  });
  it('finding 10: a long run of flags and pr words is classified in linear time', () => {
    const cmd = 'gh ' + '-a pr '.repeat(40000);
    const t = Date.now();
    parseMerge(cmd, '/w');
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it('round 3: a mention with very many quoted words is classified in linear time', () => {
    for (const cmd of ['echo "gh pr merge" ' + '"x" '.repeat(200000), 'git commit -m "gh -R o/n pr merge" ' + '"x" '.repeat(200000)]) {
      const t = Date.now();
      parseMerge(cmd, '/w');
      expect(Date.now() - t).toBeLessThan(5000);
    }
  }, 60000);
  it('a literal gh pr merge is still detected', () => {
    expect(parseMerge('gh pr merge 5', '/w').kind).toBe('merge');
  });
});
