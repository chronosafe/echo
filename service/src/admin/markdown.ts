import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';

// Document content is written by agents and is untrusted. The safety rests on four things, in order:
//  1. html:false, so raw HTML (inline or block) is escaped as text and never passed through.
//  2. validateLink is an allowlist (http:, https:, mailto:, and pure #anchors). Everything else, including every relative
//     or path link and javascript:, data: and vbscript:, fails, and markdown-it then leaves the source as plain text.
//  3. images are never emitted as <img>: an image renders as its alt text, linked only if its URL passes the allowlist.
//  4. every attribute value is escaped by markdown-it's renderer; nothing user-supplied is spliced in as markup.
// The CSP (default-src 'self', nonce scripts) is unchanged and is a further backstop.

/** Largest content (in characters) that is rendered; a bigger document is shown raw only. Pathological input (for
 *  example '![a' repeated) costs up to ~0.5 s at this size, acceptable on the Workers paid plan's 30 s CPU limit.
 *  ?raw=1 on the document page never calls the renderer, as the way back in for any document that renders badly. */
export const MD_RENDER_MAX = 256 * 1024;

/** A markdown document is one whose stored format is markdown, or whose name ends in .md or .markdown. */
export function isMarkdownDoc(d: { name: string; format: string }): boolean {
  return d.format === 'markdown' || /\.(md|markdown)$/i.test(d.name);
}

// Strict, on the URL exactly as it will be emitted: no stripping of whitespace or control characters, because a
// browser may strip some of them from a scheme. markdown-it has already percent-encoded such characters by the time
// validateLink runs, and anything that still does not match the allowlist is refused.
function allowed(url: string): boolean {
  const s = url.toLowerCase();
  return s.startsWith('#') || /^https?:\/\/[a-z0-9[]/.test(s) || /^mailto:[^\s/\\]/.test(s);
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
md.validateLink = allowed;

const esc = md.utils.escapeHtml;
const ABSOLUTE_ATTRS = 'target="_blank" rel="noopener noreferrer nofollow ugc"';

type LinkEnv = Record<string, unknown> & { inLink?: boolean; closeTag?: string };

/** Links that leave the page open in a new tab; a mailto: link and an in-page anchor do not. */
function linkAttrs(href: string): string {
  const h = href.toLowerCase();
  return h.startsWith('#') || h.startsWith('mailto:') ? '' : ` ${ABSOLUTE_ATTRS}`;
}

md.renderer.rules.link_open = (tokens: Token[], idx: number, _options, env: LinkEnv | undefined) => {
  const t = tokens[idx]!;
  const href = String(t.attrGet('href') ?? '');
  const ok = allowed(href);
  if (env) {
    env.inLink = true;
    env.closeTag = ok ? 'a' : 'span';
  }
  if (!ok) return '<span>'; // e.g. an empty destination, which markdown-it does not pass to validateLink: never an <a> without a valid href
  const title = String(t.attrGet('title') ?? '');
  return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${linkAttrs(href)}>`;
};

md.renderer.rules.link_close = (_tokens, _idx, _options, env: LinkEnv | undefined) => {
  const tag = env?.closeTag ?? 'a';
  if (env) env.inLink = false;
  return `</${tag}>`;
};

md.renderer.rules.image = (tokens: Token[], idx: number, options, env: LinkEnv | undefined, self) => {
  const t = tokens[idx]!;
  const src = String(t.attrGet('src') ?? '');
  const alt = esc(self.renderInlineAsText(t.children ?? [], options, env));
  if (!allowed(src) || env?.inLink) return alt; // never nest an <a> inside an <a>
  const label = alt || esc(src);
  return `<a href="${esc(src)}"${linkAttrs(src)}>${label}</a>`;
};

md.renderer.rules.table_open = () => '<div class="tblwrap"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

// Bidirectional controls would let link text or other text visually spoof something else. Removed from the rendered
// output (which also covers entity-decoded ones); the raw view is untouched.
const BIDI = /[\u202a-\u202e\u2066-\u2069\u061c\u200e\u200f]/g;

/** Safe HTML for untrusted markdown. Returns null when the document is too large to render. */
export function renderMarkdown(src: string, max = MD_RENDER_MAX): string | null {
  if (src.length > max) return null;
  return md.render(src, {}).replace(BIDI, '');
}
