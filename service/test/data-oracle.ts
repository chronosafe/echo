/**
 * A strict oracle for the Shared data admin pages, in the spirit of the one #7 wrote for rendered markdown: after the
 * static <style> and the nonce <script> are taken out, every '<' must open a tag of exactly the shape the templates
 * emit, with allowlisted names and attributes, quoted values free of '<' and '>', balanced tags, and links that only
 * go to the admin itself. Agent-written text is escaped, so none of it can open a tag. Returns the violations.
 */
const TAGS: Record<string, string[]> = {
  html: ['lang'], head: [], meta: ['charset', 'name', 'content'], title: [], body: [], header: ['class'], main: ['class'],
  div: ['class', 'id'], noscript: [], aside: [], a: ['href', 'class', 'aria-current'], svg: ['width', 'height', 'viewbox', 'aria-hidden', 'fill', 'stroke', 'stroke-width', 'stroke-linecap'],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke'], path: ['d', 'opacity'], form: ['class', 'method', 'action'], button: ['class', 'type'],
  nav: ['class', 'aria-label'], h2: ['class'], h3: ['class'], p: ['class'], section: ['class', 'id'], table: ['class'], thead: [], tbody: [],
  tr: ['class'], th: ['class'], td: ['class', 'data-label'], span: ['class'], time: ['datetime', 'title'], b: [], input: ['type', 'name', 'value', 'placeholder', 'aria-label', 'maxlength', 'required', 'checked'],
  h1: ['class'], label: ['class'], details: ['class', 'open'], summary: ['class'], pre: [], wbr: [], ul: ['class'], ol: ['class'], li: ['class'], code: [], select: ['name', 'aria-label', 'data-autosubmit'], option: ['value', 'selected'], textarea: ['name', 'aria-label'], i: [],
};
const VOID = new Set(['meta', 'input', 'wbr', 'circle', 'path']);

export function violations(page: string): string[] {
  const errs: string[] = [];
  const body = page.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script nonce="[A-Za-z0-9+/=_-]+"[^>]*>[\s\S]*?<\/script>/g, '').replace(/^<!doctype html>\s*/i, '');
  const stack: string[] = [];
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    const text = body.slice(i, lt < 0 ? body.length : lt);
    if (/[<>]/.test(text)) errs.push(`raw angle bracket in text: ${JSON.stringify(text.slice(0, 60))}`);
    if (lt < 0) break;
    const m = /^<(\/?)([a-z][a-z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:="[^"<>]*")?)*)\s*(\/?)>/.exec(body.slice(lt));
    if (!m) {
      errs.push(`malformed tag at ${JSON.stringify(body.slice(lt, lt + 60))}`);
      break;
    }
    const [whole, close, name, attrs] = m;
    const allowed = TAGS[name!];
    if (!allowed) errs.push(`tag <${name}> is not allowed`);
    else if (!close) {
      for (const a of attrs!.matchAll(/\s+([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g)) {
        const an = a[1]!.toLowerCase();
        const av = a[2] ?? '';
        if (!allowed.includes(an)) errs.push(`attribute ${an} is not allowed on <${name}>`);
        if (an === 'href' && !/^(\/admin(\/|$)|#)/.test(av.replace(/&amp;/g, '&'))) errs.push(`href leaves the admin: ${av}`);
        if (an === 'action' && !/^\/admin\//.test(av)) errs.push(`form action leaves the admin: ${av}`);
        if (/^on/.test(an)) errs.push(`event handler ${an}`);
      }
    }
    if (close) {
      if (stack.pop() !== name) errs.push(`unbalanced </${name}>`);
    } else if (!VOID.has(name!) && !m[4]) stack.push(name!);
    i = lt + whole!.length;
  }
  if (stack.length) errs.push(`unclosed: ${stack.join(',')}`);
  return errs;
}
