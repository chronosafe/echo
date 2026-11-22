import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MD_RENDER_MAX, isMarkdownDoc, renderMarkdown } from '../src/admin/markdown';
import { saveDocument } from '../src/domain/documents';
import { seed, testCtx } from './helpers';

const ORIGIN = 'https://echo.test';
const ctx = testCtx();
let ip = 200;
let s: Awaited<ReturnType<typeof seed>>;
let cookie: string;
let P: string;

async function sessionCookie(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.2.0.${++ip}` },
    body: new URLSearchParams({ password: 'correct horse' }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: { cookie } });

beforeEach(async () => {
  ctx.setNow(new Date().toISOString());
  s = await seed(ctx);
  cookie = await sessionCookie();
  P = `/admin/p/${s.project.id}`;
});

const TAG_ATTRS: Record<string, string[]> = {
  p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ['start'], li: [], em: [], strong: [], s: [],
  code: ['class'], pre: [], blockquote: [], hr: [], br: [], table: [], thead: [], tbody: [], tr: [],
  th: ['style'], td: ['style'], div: ['class'], span: [], a: ['href', 'title', 'target', 'rel'],
};
const VOID = new Set(['hr', 'br']);
const decodeEntities = (v: string) =>
  v.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|lt|gt);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });

/**
 * A strict oracle for the output. Every '<' must open a tag of exactly the shape markdown-it emits (lower-case name,
 * attributes as name="value" with no quotes, '<' or '>' inside the value); names and attributes are allowlisted per tag;
 * tags must balance; every href must be an allowlisted URL. Returns the violations, empty when the output is safe.
 */
function violations(out: string): string[] {
  const errs: string[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < out.length) {
    const lt = out.indexOf('<', i);
    const text = out.slice(i, lt < 0 ? out.length : lt);
    if (text.includes('>')) errs.push('raw > in text');
    if (lt < 0) break;
    const gt = out.indexOf('>', lt);
    if (gt < 0) {
      errs.push('unterminated tag');
      break;
    }
    const tag = out.slice(lt, gt + 1);
    i = gt + 1;
    const m = /^<(\/?)([a-z][a-z0-9]*)((?: [a-z-]+="[^"<>]*")*)>$/.exec(tag);
    if (!m) {
      errs.push(`bad tag shape: ${tag.slice(0, 80)}`);
      continue;
    }
    const [, close, name, attrs] = m as unknown as [string, string, string, string];
    if (!(name in TAG_ATTRS)) errs.push(`tag not allowed: ${name}`);
    if (close) {
      if (attrs) errs.push('attributes on a close tag');
      if (stack.pop() !== name) errs.push(`unbalanced </${name}>`);
      continue;
    }
    if (name === 'a' && stack.includes('a')) errs.push('nested <a>');
    if (!VOID.has(name)) stack.push(name);
    const seen = new Set<string>();
    for (const a of attrs.matchAll(/ ([a-z-]+)="([^"]*)"/g)) {
      const an = a[1]!;
      const v = decodeEntities(a[2]!);
      if (seen.has(an)) errs.push(`duplicate attribute ${an}`);
      seen.add(an);
      if (!(TAG_ATTRS[name] ?? []).includes(an)) errs.push(`attribute ${an} not allowed on ${name}`);
      if (an === 'style' && !/^text-align:(left|right|center)$/.test(v)) errs.push(`bad style ${v}`);
      if (an === 'class' && name === 'div' && v !== 'tblwrap' && v !== 'md') errs.push(`bad div class ${v}`);
      if (an === 'class' && name === 'code' && !/^language-\S*$/.test(v)) errs.push(`bad code class ${v}`);
      if (an === 'target' && v !== '_blank') errs.push('bad target');
      if (an === 'target' && name !== 'a') errs.push('target off an anchor');
      if (an === 'rel' && v !== 'noopener noreferrer nofollow ugc') errs.push('bad rel');
      if (an === 'href' && !/^(#|https?:\/\/[a-z0-9[]|mailto:[^\s/\\])/i.test(v)) errs.push(`bad href ${v}`);
      if (an === 'href' && /[\u0000- \u007f]/.test(v) && !v.startsWith('#')) errs.push(`control or space in href ${JSON.stringify(v)}`);
    }
    if (name === 'a' && !seen.has('href')) errs.push('<a> without href');
    if (name === 'a' && seen.has('href')) {
      const href = decodeEntities(/ href="([^"]*)"/.exec(attrs)![1]!).toLowerCase();
      const external = !href.startsWith('#') && !href.startsWith('mailto:');
      if (external && !(seen.has('target') && seen.has('rel'))) errs.push('external link without target and rel');
      if (!external && seen.has('target')) errs.push('in-page or mailto link with target');
    }
  }
  if (stack.length) errs.push(`unclosed: ${stack.join(',')}`);
  return errs;
}

function assertSafe(out: string): void {
  expect(violations(out)).toEqual([]);
  expect(out).not.toMatch(/[‪-‮⁦-⁩]/);
}

describe('the safety oracle itself', () => {
  it('rejects the markup it must catch', () => {
    for (const bad of [
      '<a onclick=alert(1)>x</a>',
      '<a href=javascript:alert(1)>x</a>',
      "<a href='javascript:alert(1)'>x</a>",
      '<details open ontoggle=alert(1)>x</details>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="https://x.test" onclick="x">x</a>',
      '<img src="https://x.test/a.png">',
      '<script>alert(1)</script>',
      '<p>x</p><p onmouseover="x">y</p>',
      '<A HREF="https://x.test">x</A>',
      '<a href="https://x.test">x',
      '<a href="https://x.test">x</a>',
      '<a href="mailto:a@x.test" target="_blank" rel="noopener noreferrer nofollow ugc">x</a>',
    ]) expect(violations(bad), bad).not.toEqual([]);
  });
  it('accepts what the renderer emits', () => {
    expect(violations('<p>a <a href="https://x.test/p?q=1&amp;r=2" title="t" target="_blank" rel="noopener noreferrer nofollow ugc">b</a></p>\n')).toEqual([]);
  });
});

describe('which documents render', () => {
  it('uses the stored format or a .md / .markdown name', () => {
    expect(isMarkdownDoc({ name: 'a', format: 'markdown' })).toBe(true);
    expect(isMarkdownDoc({ name: 'a.MD', format: 'json' })).toBe(true);
    expect(isMarkdownDoc({ name: 'a.markdown', format: 'json' })).toBe(true);
    expect(isMarkdownDoc({ name: 'a.json', format: 'json' })).toBe(false);
    expect(isMarkdownDoc({ name: 'amd', format: 'json' })).toBe(false);
  });
});

describe('rendering', () => {
  it('renders headings, lists, tables and code', () => {
    const out = renderMarkdown('# Title\n\n- a\n- b\n\n1. x\n\n| h1 | h2 |\n|----|:--:|\n| c1 | c2 |\n\n```js\nlet a = 1 < 2;\n```\n\n`inline`\n')!;
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<ol>');
    expect(out).toMatch(/<table>[\s\S]*<th>h1<\/th>[\s\S]*<td[^>]*>c2<\/td>/);
    expect(out).toContain('<div class="tblwrap">');
    expect(out).toContain('let a = 1 &lt; 2;');
    expect(out).toContain('<code>inline</code>');
    assertSafe(out);
  });

  it('allows http, https, mailto and #anchors; absolute links open in a new tab, anchors stay', () => {
    const out = renderMarkdown('[a](https://x.test/p?q=1) [b](http://x.test) [c](mailto:me@x.test) [d](#sec)')!;
    expect(out).toContain('<a href="https://x.test/p?q=1" target="_blank" rel="noopener noreferrer nofollow ugc">a</a>');
    expect(out).toContain('<a href="http://x.test" target="_blank"');
    expect(out).toContain('<a href="mailto:me@x.test">c</a>');
    expect(out).toContain('<a href="#sec">d</a>');
    expect(out).not.toMatch(/href="#sec"[^>]*target/);
    assertSafe(out);
  });

  it('renders relative and path links as plain text', () => {
    for (const u of ['/admin/p/1', '../x', 'x.md', './x', '//evil.test/x', 'ftp://x.test', 'file:///etc/passwd', '?q=1']) {
      const out = renderMarkdown(`[t](${u})`)!;
      expect(out, u).not.toContain('<a');
      expect(out, u).toContain('[t]');
      assertSafe(out);
    }
  });

  it('never emits <img>: an image is its alt text, linked only when the URL passes the allowlist', () => {
    expect(renderMarkdown('![cat *pic*](https://x.test/c.png)')!).toBe('<p><a href="https://x.test/c.png" target="_blank" rel="noopener noreferrer nofollow ugc">cat pic</a></p>\n');
    expect(renderMarkdown('![cat](http://x.test/c.png)')!).toContain('<a href="http://x.test/c.png"');
    expect(renderMarkdown('![cat](/local.png)')!).not.toContain('<a');
    expect(renderMarkdown('![cat](javascript:alert(1))')!).not.toContain('<a');
    for (const src of ['![a](https://x.test/c.png)', '![a](/x.png)', '![a](data:image/png;base64,AAAA)', '![<b>a</b>](https://x.test/y.png "t")']) assertSafe(renderMarkdown(src)!);
  });

  it('does not nest a link inside a link', () => {
    const out = renderMarkdown('[![i](http://a.test/i.png)](http://b.test)')!;
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain('>i</a>');
    assertSafe(out);
  });

  it('adds no heading ids, so nothing can clobber a page element', () => {
    expect(renderMarkdown('# Login\n## main')!).not.toMatch(/\sid=/);
  });
});

describe('XSS battery', () => {
  const cases: Record<string, string> = {
    script: '<script>alert(1)</script>',
    imgOnerror: '<img src=x onerror=alert(1)>',
    jsLink: '[x](javascript:alert(1))',
    jsMixedCase: '[x](JaVaScRiPt:alert(1))',
    jsLeadingSpace: '[x]( javascript:alert(1))',
    jsAngle: '[x](<javascript:alert(1)>)',
    jsTab: '[x](java\tscript:alert(1))',
    jsNewline: '[x](java\nscript:alert(1))',
    jsEntityColon: '[x](javascript&colon;alert(1))',
    jsEntityNumeric: '[x](&#106;avascript:alert(1))',
    jsPercent: '[x](javascript%3Aalert(1))',
    jsZeroWidth: '[x](java\u200bscript:alert(1))',
    jsCtrl: '[x](\u0001javascript:alert(1))',
    dataLink: '[x](data:text/html,<script>alert(1)</script>)',
    dataB64: '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    vbs: '[x](vbscript:msgbox(1))',
    autolink: '<javascript:alert(1)>',
    autolinkData: '<data:text/html,hi>',
    htmlBlock: '<div onclick="alert(1)">\n<p>hi</p>\n</div>\n\n<iframe src="javascript:alert(1)"></iframe>',
    htmlComment: '<!-- --><script>alert(1)</script>',
    svg: '<svg onload=alert(1)></svg>',
    titleInjection: '[x](https://a.test "t\\" onmouseover=\\"alert(1)")',
    titleInjection2: '[x](https://a.test "\\"><script>alert(1)</script>")',
    titleQuote: '[x](https://a.test \'a" onfocus="alert(1)\')',
    refStyle: '[x][r]\n\n[r]: javascript:alert(1)',
    refStyleTitle: '[x][r]\n\n[r]: https://a.test "t\\" onmouseover=\\"alert(1)"',
    imgJs: '![x](javascript:alert(1))',
    imgData: '![x](data:image/svg+xml,<svg onload=alert(1)>)',
    imgAltInjection: '![" onerror="alert(1)](https://a.test/x.png)',
    hrefInjection: '[x](https://a.test" onclick="alert(1))',
    hrefInjection2: '[x](<https://a.test"onclick="alert(1)>)',
    fenceInfo: '```"><script>alert(1)</script>\nx\n```',
    tableAlign: '| a |\n|:-"onmouseover="x|\n| b |',
    linkText: '[<script>alert(1)</script>](https://a.test)',
    emphasisHtml: '*<b onclick=alert(1)>x</b>*',
    backslashHtml: '\\<script>alert(1)</script>',
    entityHtml: '&lt;script&gt;alert(1)&lt;/script&gt; &#60;script&#62;',
  };
  for (const [name, src] of Object.entries(cases)) {
    it(`${name} produces no executable output`, () => {
      const out = renderMarkdown(src)!;
      assertSafe(out);
      expect(out).not.toMatch(/href="\s*(javascript|data|vbscript)/i);
    });
  }

  it('also holds through the admin page, and the CSP still forbids inline script', async () => {
    const all = `# Evil battery\n\n${Object.values(cases).join('\n\n')}`;
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'evil.md', format: 'markdown', content: all });
    const res = await get(`${P}/documents/evil.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const start = text.indexOf('<div class="md">');
    const end = text.indexOf('<details class="rawdoc">');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const rendered = text.slice(start, end);
    expect(rendered.length).toBeGreaterThan(100);
    expect(rendered).toContain('<h1>Evil battery</h1>');
    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    assertSafe(rendered);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'nonce-[^']+'; form-action 'self'; frame-ancestors 'none'/);
  });
});

describe('document page', () => {
  it('shows rendered markdown by default with the exact raw text in a collapsed, escaped <details>', async () => {
    const content = '# Hi\n\n<b>x</b> & "q" [l](javascript:1)\n\n| a |\n|---|\n| 1 |\n';
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'n.md', format: 'markdown', content });
    const text = await (await get(`${P}/documents/n.md`)).text();
    expect(text).toContain('<div class="md"><h1>Hi</h1>');
    const m = text.match(/<details class="rawdoc"><summary>Raw markdown<\/summary><pre>\n([\s\S]*?)<\/pre><\/details>/)!;
    expect(m).toBeTruthy();
    expect(m[1]).toBe(content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    expect(text).not.toContain('<details class="rawdoc" open');
    expect(text.indexOf('class="md"')).toBeLessThan(text.indexOf('class="rawdoc"'));
  });

  it('renders old versions too, and a .md name with json content', async () => {
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'v.md', format: 'markdown', content: '# One' });
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'v.md', format: 'markdown', content: '# Two' });
    expect(await (await get(`${P}/documents/v.md?version=1`)).text()).toContain('<h1>One</h1>');
    expect(await (await get(`${P}/documents/v.md`)).text()).toContain('<h1>Two</h1>');
  });

  it('renders a .md-named document even when its stored format is json', async () => {
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'j.md', format: 'json', content: '"# quoted"' });
    expect(await (await get(`${P}/documents/j.md`)).text()).toContain('class="md"');
  });

  it('leaves a JSON document as a plain <pre>', async () => {
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'cfg.json', format: 'json', content: '{"a":"# not a heading","b":"<i>"}' });
    const text = await (await get(`${P}/documents/cfg.json`)).text();
    expect(text).toContain('<pre>{&quot;a&quot;:&quot;# not a heading&quot;,&quot;b&quot;:&quot;&lt;i&gt;&quot;}</pre>');
    expect(text).not.toContain('class="md"');
    expect(text).not.toContain('<details class="rawdoc"');
  });
});

describe('links, bidi and spans', () => {
  it('renders an empty link destination as a span, never an <a> without an href', () => {
    const out = renderMarkdown('[x]()')!;
    expect(out).toContain('<span>x</span>');
    assertSafe(out);
  });
  it('opens mailto: links in the same tab, with no target', () => {
    const out = renderMarkdown('[m](mailto:a@x.test)')!;
    expect(out).toContain('<a href="mailto:a@x.test">m</a>');
    assertSafe(out);
  });
  it('strips bidi control characters from rendered text and link text, however they are written', () => {
    for (const src of ['a\u202eb', '[ev\u202eil](https://x.test)', 'x&#x202E;y', 'x&#8238;y', '\u2066a\u2069', 'p\u200eq', '[\u200f[x](https://a.test)](https://b.test)', 'a\u061cb', '`c\u202ed`', '```\nf\u202ee\n```']) {
      const out = renderMarkdown(src)!;
      expect(out, src).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    }
    expect(renderMarkdown('[ev\u202eil](https://x.test)')!).toContain('>evil</a>');
  });
});

describe('raw-only escape hatch', () => {
  it('?raw=1 never calls the renderer, on the latest and on a version page, and links to and from it work', async () => {
    const mod = await import('../src/admin/markdown');
    const spy = vi.spyOn(mod, 'renderMarkdown');
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'r.md', format: 'markdown', content: '# One <b>' });
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'r.md', format: 'markdown', content: '# Two' });
    const list = await (await get(`${P}/documents`)).text();
    expect(list).toContain(`href="${P}/documents/r.md?raw=1"`);
    for (const path of [`${P}/documents/r.md?raw=1`, `${P}/documents/r.md?version=1&raw=1`]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('class="md"');
      expect(text).toContain('<pre>');
      expect(text).toContain('View rendered');
      expect(text).toContain('?version=1&amp;raw=1'); // the version pills stay raw
    }
    expect((await (await get(`${P}/documents/r.md?version=1&raw=1`)).text())).toContain('# One &lt;b&gt;');
    expect(spy).not.toHaveBeenCalled();
    const rendered = await (await get(`${P}/documents/r.md?version=1`)).text();
    expect(rendered).toContain('View raw only');
    expect(rendered).toContain('?version=1&raw=1');
    spy.mockRestore();
  });
  it('shows no raw link for a JSON document', async () => {
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'c.json', format: 'json', content: '{}' });
    expect(await (await get(`${P}/documents`)).text()).not.toContain('c.json?raw=1');
  });
});

describe('size and speed', () => {
  const mixed = (n: number) => {
    const block = '# Heading\n\nSome *emphasis*, **strong**, `code`, and a [link](https://x.test/a) with text.\n\n- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode fence\n```\n\n> quote\n\n';
    return block.repeat(Math.ceil(n / block.length)).slice(0, n);
  };
  const time = (src: string) => {
    const t = performance.now();
    const out = renderMarkdown(src);
    return { ms: performance.now() - t, out };
  };

  it('does not render past the limit, and the page falls back to raw with a note', async () => {
    expect(renderMarkdown('a'.repeat(MD_RENDER_MAX + 1))).toBeNull();
    expect(renderMarkdown('a'.repeat(MD_RENDER_MAX))).not.toBeNull();
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'big.md', format: 'markdown', content: 'x'.repeat(MD_RENDER_MAX + 1) });
    const text = await (await get(`${P}/documents/big.md`)).text();
    expect(text).toContain('Too large to render');
    expect(text).not.toContain('class="md"');
  });

  it('renders 256 KiB of realistic markdown quickly', () => {
    const { ms, out } = time(mixed(MD_RENDER_MAX));
    expect(out).not.toBeNull();
    assertSafe(out!);
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(300);
  });

  it('renders pathological shapes at the cap in bounded time, and safely', () => {
    const n = MD_RENDER_MAX;
    const inputs: Record<string, string> = {
      unclosedBrackets: '['.repeat(n),
      nestedBrackets: '[[[['.repeat(n / 4),
      bangBrackets: '![a'.repeat(n / 3 | 0),
      bangs: '![['.repeat(n / 3 | 0),
      autolinks: '<a@b.c>'.repeat(n / 7 | 0),
      unclosedEmphasis: '*a'.repeat(n / 2),
      underscoreRuns: '_'.repeat(n),
      backticks: '`a'.repeat(n / 2),
      deepQuotes: '> '.repeat(n / 2 - 1) + 'x',
      deepLists: Array.from({ length: 2000 }, (_, i) => ' '.repeat(i % 100) + '- x').join('\n'),
      linkSpam: '[a](b '.repeat(n / 6 | 0),
      refSpam: Array.from({ length: 6000 }, (_, i) => `[r${i}]: https://x.test/${i}`).join('\n') + '\n' + '[r1][r2][r3]'.repeat(4000),
      tableWide: '|' + 'a|'.repeat(5000) + '\n|' + '-|'.repeat(5000) + '\n' + ('|' + 'b|'.repeat(5000) + '\n').repeat(10),
      entities: '&amp;'.repeat(n / 5 | 0),
      htmlOpen: '<a '.repeat(n / 3 | 0),
    };
    for (const [name, src] of Object.entries(inputs)) {
      expect(src.length, name).toBeLessThanOrEqual(MD_RENDER_MAX);
      const { ms, out } = time(src);
      expect(out, name).not.toBeNull();
      expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(3000);
      assertSafe(out!);
    }
  });
});
