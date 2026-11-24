import { html, raw } from 'hono/html';
import type { AgentRow } from '../domain/agents';
import type { EventView, ScheduleRow } from '../domain/calendar';
import type { Change } from '../domain/changelog';
import type { HoldView } from '../domain/holds';
import type { MessageLine, PendingRow } from '../domain/messages';
import type { ProjectRow, RepoStatusRow } from '../domain/projects';
import type { DocumentInfo, Document } from '../domain/documents';
import type { ScratchEntry } from '../domain/scratchpad';
import type { WebhookInfo } from '../domain/webhooks';
import type { Todo } from '../domain/todos';
import { DEFAULT_ZONE, TZ_SCRIPT, fmtDateTime, fmtTime } from './localtime';
import type { DayOption } from './localtime';
import { summarizeMergeDetail } from './summary';
import { isMarkdownDoc, renderMarkdown } from './markdown';
import type { AdminEntryView, AdminList, AdminVersionView } from '../domain/data';
import type { DiffLine } from './data-view';
import { pretty, visible } from './data-view';

// Every dynamic value below goes through `html` tagged templates, which escape it. `raw()` is used only for the static
// CSS and the static script, neither of which contains any server data.

type Html = ReturnType<typeof html>;

/** An open document: rendered markdown with the raw text one click away, or the plain text for anything else.
 *  With rawOnly the renderer is never called. */
function docBody(doc: Document, rawOnly: boolean, base: string): Html {
  const md = isMarkdownDoc(doc);
  const rendered = md && !rawOnly ? renderMarkdown(doc.content) : null;
  const q = `${base}/documents/${encodeURIComponent(doc.name)}?version=${doc.version}`;
  if (rendered !== null) {
    return html`<p class="hint"><a href="${q}&raw=1">View raw only</a></p><div class="md">${raw(rendered)}</div><details class="rawdoc"><summary>Raw markdown</summary><pre>
${doc.content}</pre></details>`;
  }
  return html`${md && rawOnly ? html`<p class="hint">Raw only. <a href="${q}">View rendered</a></p>` : ''}${md && !rawOnly ? html`<p class="hint">Too large to render, showing the raw text.</p>` : ''}<pre>${md ? '\n' : ''}${doc.content}</pre>`;
}

// The look: a strip board. Every row that carries a state has a coloured edge on its left, and every state is a badge
// in one of six tones, used the same way on every page:
//   stop  red     blocking hold, escalated, window closed, blocked, objected, GitHub error, revoked
//   wait  amber   waiting approval, awaiting acknowledgment, not delivered, no response
//   defer violet  deferred
//   go    green   approved, acknowledged, done, App installed
//   info  teal    scheduled, delivered, advisory hold, claimed, next
//   off   slate   merged, cancelled, withdrawn, archived, removed
// No external fonts, images or CDNs (the CSP allows none): system font stacks, inline SVG and CSS only.
const CSS = raw(`
:root {
  color-scheme: light dark;
  --ground:#e9edf0; --panel:#ffffff; --sunk:#f4f6f8; --ink:#17212b; --mut:#5a6774; --rule:#d3dae0; --hair:#e5e9ed;
  --acc:#0b6870; --acc-ink:#ffffff; --acc-soft:#dbefef;
  --stop:#b42318; --stop-bg:#fcebe9; --wait:#965800; --wait-bg:#fff1d6; --defer:#5a47ae; --defer-bg:#eeeafb;
  --go:#1d7444; --go-bg:#e2f3e8; --info:#0b6870; --info-bg:#dbefef; --off:#5a6774; --off-bg:#e6eaee;
  --f-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --f-head: "Avenir Next Condensed", "Bahnschrift", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif;
  --f-code: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --r: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground:#121920; --panel:#1a222a; --sunk:#151c23; --ink:#dce3e9; --mut:#8e9aa6; --rule:#2b3640; --hair:#232d36;
    --acc:#5ec2c7; --acc-ink:#0c1b1d; --acc-soft:#16343a;
    --stop:#ff8f84; --stop-bg:#3a1f1d; --wait:#f0b55a; --wait-bg:#372a15; --defer:#b8acf6; --defer-bg:#282447;
    --go:#7fd4a0; --go-bg:#173227; --info:#6fced2; --info-bg:#15343a; --off:#9aa6b2; --off-bg:#25303a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.5 var(--f-ui); font-variant-numeric: tabular-nums; }
a { color: var(--acc); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; border-radius: 4px; }
h1, h2, h3 { font-family: var(--f-head); font-weight: 600; letter-spacing: .005em; line-height: 1.15; margin: 0; }
h1 { font-size: 34px; }
h2 { font-size: 21px; }
h3 { font-size: 17px; margin-bottom: 10px; }
p { margin: 0 0 10px; }
code, .ref, pre { font-family: var(--f-code); font-size: .92em; }
code { overflow-wrap: anywhere; }
.ref { font-weight: 600; white-space: nowrap; }
.mut, .sub { color: var(--mut); }
.sub { font-size: 13px; margin-top: 2px; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* top bar */
.top { background: var(--panel); border-bottom: 1px solid var(--rule); }
.top .bar { max-width: 1240px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); text-decoration: none; font: 600 19px/1 var(--f-head); }
.brand svg { color: var(--acc); flex: none; }
.wrap { max-width: 1240px; margin: 0 auto; padding: 18px 16px 48px; }

/* page head */
.crumb { margin: 0 0 6px; font-size: 14px; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; margin-bottom: 14px; }
.head .badge { position: relative; top: -4px; }
.tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: thin; border-bottom: 1px solid var(--rule); margin: 0 0 18px; }
.tabs a { flex: none; padding: 8px 12px 9px; color: var(--mut); text-decoration: none; font-weight: 550; border-bottom: 3px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tabs a:hover { color: var(--ink); }
.tabs a.on { color: var(--ink); border-bottom-color: var(--acc); }
.page-title { margin: 0 0 14px; }

/* the situation line: what needs the owner, at a glance */
.situation { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; padding: 0; list-style: none; }
.situation a, .situation span { display: inline-flex; align-items: baseline; gap: 7px; padding: 7px 13px 7px 11px; border-radius: 8px; text-decoration: none;
  background: var(--tone-bg); color: var(--tone); border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent); font-weight: 550; }
.situation b { font: 600 22px/1 var(--f-head); }
.situation a:hover { border-color: var(--tone); }

/* tones */
.t-stop { --tone: var(--stop); --tone-bg: var(--stop-bg); }
.t-wait { --tone: var(--wait); --tone-bg: var(--wait-bg); }
.t-defer { --tone: var(--defer); --tone-bg: var(--defer-bg); }
.t-go { --tone: var(--go); --tone-bg: var(--go-bg); }
.t-info { --tone: var(--info); --tone-bg: var(--info-bg); }
.t-off { --tone: var(--off); --tone-bg: var(--off-bg); }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 1px 9px 1px 7px; border-radius: 999px; font-size: 13px; font-weight: 600; line-height: 20px;
  background: var(--tone-bg, var(--off-bg)); color: var(--tone, var(--off)); white-space: nowrap; vertical-align: 1px; }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.count { display: inline-block; min-width: 24px; padding: 0 7px; margin-left: 6px; border-radius: 999px; text-align: center; font: 600 14px/22px var(--f-ui);
  background: var(--off-bg); color: var(--off); vertical-align: 3px; }
.count.t-stop, .count.t-wait { background: var(--tone); color: var(--panel); }

/* panels */
.panel { background: var(--panel); border: 1px solid var(--rule); border-radius: var(--r); padding: 14px 16px 16px; margin-bottom: 18px; min-width: 0; overflow-x: auto; }
.panel > h2, .panel > .ph { margin-bottom: 12px; }
.ph { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.ph .mut { font-size: 13px; }
.empty { color: var(--mut); margin: 0; padding: 10px 12px; background: var(--sunk); border-radius: 8px; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: start; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; align-items: start; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 960px) { .layout, .cols { grid-template-columns: minmax(0, 1fr); } }
.pair { margin-bottom: 18px; }
.pair > .panel { margin-bottom: 0; }
@media (max-width: 700px) {
  .pair { grid-template-columns: minmax(0, 1fr); }
  h1 { font-size: 29px; }
  .tabs { -webkit-mask-image: linear-gradient(to right, #000 82%, transparent); mask-image: linear-gradient(to right, #000 82%, transparent); padding-right: 64px; }
}

/* banners */
.banner { padding: 10px 14px; margin: 0 0 14px; border-radius: 8px; background: var(--wait-bg); color: var(--ink);
  border: 1px solid color-mix(in srgb, var(--wait) 30%, transparent); border-left: 5px solid var(--wait); overflow-wrap: anywhere; }
.banner.err { background: var(--stop-bg); border-color: color-mix(in srgb, var(--stop) 30%, transparent); border-left-color: var(--stop); }
.banner.ok { background: var(--go-bg); border-color: color-mix(in srgb, var(--go) 30%, transparent); border-left-color: var(--go); }
.secret { background: var(--panel); border: 2px solid var(--wait); border-radius: var(--r); padding: 14px 16px; margin: 0 0 18px; }
.secret strong { display: block; font: 600 19px/1.2 var(--f-head); margin-bottom: 8px; }
.secret code { display: block; padding: 10px 12px; margin-bottom: 8px; background: var(--sunk); border: 1px dashed var(--rule); border-radius: 6px; font-size: 15px; user-select: all; }

/* tables: rows are strips with a status edge; on a phone each row becomes a card */
.tbl { width: 100%; border-collapse: collapse; }
.tbl th { text-align: left; font-size: 13px; font-weight: 600; color: var(--mut); padding: 0 10px 7px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
.tbl td { text-align: left; vertical-align: top; padding: 10px; border-bottom: 1px solid var(--hair); overflow-wrap: break-word; }
.tbl td .body { min-width: 12em; }
.who { white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.tbl td:first-child, .tbl th:first-child { padding-left: 14px; }
.tbl tr[class*="t-"] td:first-child { box-shadow: inset 4px 0 0 var(--tone); }
.tbl tr.dim > td { color: var(--mut); }
.tbl tr.next > td { background: color-mix(in srgb, var(--acc-soft) 55%, transparent); }
.tbl .when { white-space: nowrap; }
.tbl .when time { font: 600 22px/1 var(--f-head); }
.tbl .num { color: var(--mut); width: 1%; white-space: nowrap; }
.tbl td.acts { width: 1%; white-space: nowrap; }
.tbl td.acts > form.inline, .tbl td.acts > details { display: inline-block; vertical-align: top; margin: 0 6px 6px 0; }
.tbl td.acts > form.inline:has(input[type=text]) { display: flex; gap: 6px; align-items: center; margin-right: 0; }
.tbl td.acts > details[open] { display: block; white-space: normal; min-width: 18em; }
.agents td:first-child { font-weight: 600; }
.body { white-space: pre-wrap; }
@media (max-width: 760px) {
  .tbl, .tbl tbody, .tbl tr, .tbl td { display: block; width: auto; }
  .tbl thead { display: none; }
  .tbl tr { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 14px; border: 1px solid var(--rule); border-radius: 8px; padding: 8px 12px 10px 16px; margin-bottom: 10px; background: var(--panel); }
  .tbl td:first-child, .tbl td.acts, .tbl td.wide { grid-column: 1 / -1; }
  .tbl tr[class*="t-"] { box-shadow: inset 4px 0 0 var(--tone); }
  .tbl tr[class*="t-"] td:first-child { box-shadow: none; }
  .tbl td, .tbl td:first-child { padding: 5px 0; border: 0; }
  .tbl td.acts { width: auto; padding-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
  .tbl td.acts > form.inline, .tbl td.acts > details { margin: 0; }
  .tbl td.acts > form.inline:has(input[type=text]) { flex: 1 1 100%; }
  .tbl td.acts > details[open] { flex: 1 1 100%; }
  .tbl tr.next { background: color-mix(in srgb, var(--acc-soft) 55%, var(--panel)); }
  .tbl tr.next > td { background: none; }
  .tbl td[data-label]::before { content: attr(data-label); display: block; font-size: 12px; font-weight: 600; color: var(--mut); margin-bottom: 1px; }
  .tbl .num { width: auto; }
  .badge { white-space: normal; }
  .panel { padding: 12px; }
}

/* forms and buttons */
input[type=text], input[type=password], select, textarea { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--rule); border-radius: 7px; padding: 6px 9px; max-width: 100%; }
input[type=text]:focus, input[type=password]:focus, select:focus, textarea:focus { outline: 2px solid var(--acc); outline-offset: 0; border-color: var(--acc); }
input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--acc); vertical-align: -3px; margin: 0 6px 0 0; }
textarea { width: 100%; min-height: 5em; max-height: 28em; field-sizing: content; line-height: 1.45; resize: vertical; }
button, summary.btn { font: 550 14px/1.2 var(--f-ui); color: var(--ink); background: var(--panel); border: 1px solid var(--rule); border-radius: 7px; padding: 7px 12px; cursor: pointer; white-space: nowrap; }
button:hover, summary.btn:hover { border-color: var(--mut); }
button.primary { background: var(--acc); border-color: var(--acc); color: var(--acc-ink); }
button.primary:hover { filter: brightness(1.08); }
button.danger, summary.btn.danger { color: var(--stop); border-color: color-mix(in srgb, var(--stop) 35%, var(--rule)); background: transparent; }
button.danger:hover, summary.btn.danger:hover { background: var(--stop-bg); border-color: var(--stop); }
button.small, summary.btn.small { padding: 4px 9px; font-size: 13px; }
button.quiet { background: transparent; }
form.inline { display: inline; }
.acts form.inline input[type=text] { flex: 1; min-width: 0; width: 7.5em; padding: 4px 8px; font-size: 14px; }
.holds .ref { white-space: normal; }
.acts form.inline input[name=starts_at] { width: 14em; }
select { padding: 6px 28px 6px 9px; }
.msgs td.to { min-width: 7em; }
.tbl.msgs td.acts { white-space: normal; }
.tbl.msgs td.wide:nth-child(2), .tbl.holds td.wide:nth-child(2) { width: 46%; }
.change .data { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; color: var(--mut); min-width: 0; }
.field input, .field select { font-weight: 400; font-size: 15px; align-self: flex-start; }
.field.grow input, aside .field input, .solo .field input { align-self: stretch; }
.fields { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: flex-end; margin-bottom: 12px; }
.fields .grow { flex: 1 1 220px; }
.fields .grow input { width: 100%; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row input[type=text] { flex: 1 1 200px; min-width: 0; }
.hint { color: var(--mut); font-size: 13px; }
.check { display: flex; gap: 2px; align-items: flex-start; font-weight: 550; margin-bottom: 12px; }
fieldset { border: 0; padding: 0; margin: 0; }
.gap-top { margin: 10px 0 0; }
.err-text { color: var(--stop); }

/* destructive actions sit behind a disclosure with the confirmation box */
details.confirm { display: block; }
details.confirm > summary { list-style: none; display: inline-block; }
details.confirm > summary::-webkit-details-marker { display: none; }
details.confirm[open] > summary { background: var(--stop-bg); border-color: var(--stop); }
details.confirm > form { display: block; margin-top: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--stop) 35%, var(--rule)); border-radius: 8px; background: var(--stop-bg); max-width: 520px; }
details.confirm > form label { display: flex; align-items: flex-start; font-size: 14px; margin-bottom: 8px; white-space: normal; }
details.confirm > form label input { margin-top: 2px; }
.danger-zone { border-color: color-mix(in srgb, var(--stop) 40%, var(--rule)); }

/* lists */
ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain > li { padding: 8px 0; border-bottom: 1px solid var(--hair); overflow-wrap: anywhere; }
ul.plain > li:last-child { border-bottom: 0; padding-bottom: 0; }
ul.plain > li:first-child { padding-top: 0; }
.projects > li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 12px 0; }
.projects > li:first-child { padding-top: 2px; }
.projects a { font: 600 21px/1.2 var(--f-head); text-decoration: none; margin-right: auto; }
.projects a:hover { text-decoration: underline; }
.who { font-weight: 600; }
.data { overflow-wrap: anywhere; }
.change b { font-weight: 600; }
.change .data { font-family: var(--f-code); font-size: 12px; color: var(--mut); margin-top: 2px; }
.appr { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin-bottom: 6px; }
.appr:last-child { margin-bottom: 0; }
.rcpt { margin-bottom: 6px; min-width: 16em; } .rcpt:last-child { margin-bottom: 0; }
time { white-space: nowrap; }
.rcpt .badge { margin-left: 4px; }
.daypick { margin-left: auto; } .daypick select { font: inherit; }
.full { margin-top: 2px; } .full summary { cursor: pointer; font-size: 13px; color: var(--mut); } .full .body { margin-top: 4px; }
.vers { display: flex; flex-wrap: wrap; gap: 4px; }
.vers a { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--rule); text-decoration: none; font-size: 13px; }
.vers a.on { background: var(--acc); border-color: var(--acc); color: var(--acc-ink); }
.dgroup { margin: 14px 0 4px; font-size: 13px; color: var(--mut); text-transform: none; }
.pv { font-family: var(--f-code); font-size: 13px; color: var(--mut); overflow-wrap: anywhere; }
.diff { padding: 0; }
.diff div { padding: 0 12px; white-space: pre-wrap; word-break: break-word; font-family: var(--f-code); font-size: 13px; line-height: 1.5; }
.diff .add { background: rgba(46, 160, 67, .2); } .diff .del { background: rgba(248, 81, 73, .2); } .diff .gap { color: var(--mut); background: var(--hair); }
.repair { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; } .repair details { flex: 1 1 280px; }
.repair input[type=text] { width: 100%; margin: 6px 0; }
.notes { list-style: none; padding: 0; margin: 0 0 18px; }
.notes > li { margin-bottom: 12px; }
.notes .meta { font-size: 13px; color: var(--mut); margin-bottom: 5px; }
.notes form { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 14px 16px; background: var(--sunk); border: 1px solid var(--hair); border-radius: 8px; line-height: 1.5; max-height: 70vh; overflow: auto; }
.md { line-height: 1.6; overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 1.2em 0 .5em; line-height: 1.25; }
.md h1 { font-size: 1.5em; } .md h2 { font-size: 1.25em; } .md h3 { font-size: 1.1em; }
.md p, .md ul, .md ol, .md blockquote, .md .tblwrap { margin: 0 0 .9em; }
.md ul, .md ol { padding-left: 1.6em; }
.md blockquote { padding: 2px 14px; border-left: 3px solid var(--rule); color: var(--mut); }
.md code { font-family: var(--f-code); background: var(--sunk); padding: 1px 5px; border-radius: 4px; }
.md pre { margin: 0 0 .9em; }
.md pre code { background: none; padding: 0; }
.md hr { border: 0; border-top: 1px solid var(--rule); margin: 1.2em 0; }
.tblwrap { overflow-x: auto; }
.md table { border-collapse: collapse; }
.md th, .md td { border: 1px solid var(--rule); padding: 5px 10px; text-align: left; vertical-align: top; }
.md th { background: var(--sunk); }
.rawdoc { margin-top: 14px; }
.rawlink { font-size: 12px; margin-left: 6px; color: var(--mut); }
.rawdoc summary { cursor: pointer; color: var(--mut); font-size: 13px; margin-bottom: 8px; }

/* login and plain pages */
.solo { max-width: 420px; margin: 8vh auto 0; }
.solo .panel { padding: 22px 22px 24px; }
.solo h1 { margin-bottom: 14px; }
.solo input[type=password] { width: 100%; margin-top: 4px; }
`);

// Times render in one zone per page: the viewer's (echo_tz cookie) or Eastern. A view sets it on entry, and rendering
// is synchronous after that (no await between useZone and the finished string), so concurrent requests cannot see
// each other's zone. Keep it that way: never await inside a view.
let zone = DEFAULT_ZONE;
let nowIso = new Date().toISOString();
let reloadOk = false;
/** reload: the page was a GET, so the zone script may re-request it; a POST result page must never be re-requested. */
function useZone(tz: string | undefined, now?: string, reload = false): void {
  reloadOk = reload;
  zone = tz ?? DEFAULT_ZONE;
  nowIso = now ?? new Date().toISOString();
}

function layout(title: string, body: Html, opts: { nonce?: string; loggedIn?: boolean } = {}): Html {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title><style>${CSS}</style></head>
<body><header class="top"><div class="bar"><a class="brand" href="/admin"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M9.5 7.5a6.4 6.4 0 0 1 0 9"/><path d="M13 4.6a10.6 10.6 0 0 1 0 14.8" opacity=".62"/><path d="M16.6 2a14.4 14.4 0 0 1 0 20" opacity=".3"/></svg>Echo admin</a>
${opts.loggedIn === false ? '' : html`<form class="inline" method="post" action="/admin/logout"><button class="quiet">Log out</button></form>`}</div></header>
<main class="wrap">${body}</main>
${opts.nonce ? html`<script nonce="${opts.nonce}" data-reload="${reloadOk ? '1' : '0'}" data-zone="${zone}">${raw(TZ_SCRIPT)}</script>` : ''}
</body></html>`;
}

// ---------------------------------------------------------------- small pieces

type Tone = 'stop' | 'wait' | 'defer' | 'go' | 'info' | 'off';

function badge(text: Html | string, tone: Tone): Html {
  return html`<span class="badge t-${tone}">${text}</span>`;
}

function count(n: number, tone?: Tone): Html {
  return html`<span class="count${tone && n > 0 ? ` t-${tone}` : ''}">${n}</span>`;
}

/** A stored UTC time shown in the page's zone, e.g. "Nov 18, 6:00 PM EST"; the exact UTC value is in datetime and title. */
function utc(iso: string | null | undefined, none = 'never'): Html | string {
  if (!iso) return none;
  const text = fmtDateTime(iso, zone, nowIso);
  if (text === null) return html`${iso}`;
  return html`<time datetime="${iso}" title="${iso}">${text}</time>`;
}

/** owner/name with a line-break opportunity after the slash; both parts are escaped. */
function refBreak(repo: string): Html {
  const i = repo.indexOf('/');
  return i < 0 ? html`${repo}` : html`${repo.slice(0, i + 1)}<wbr>${repo.slice(i + 1)}`;
}

function duration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export function loginPage(error?: string): Html {
  return layout(
    'Echo admin login',
    html`<div class="solo"><div class="panel"><h1>Log in</h1>${error ? html`<div class="banner err">${error}</div>` : ''}
<form method="post" action="/admin/login"><p><label class="field">Password <input type="password" name="password" autofocus required></label></p>
<button class="primary">Log in</button></form></div></div>`,
    { loggedIn: false },
  );
}

export function plainPage(title: string, message: string): Html {
  return layout(
    title,
    html`<div class="solo"><div class="panel"><h1>${title}</h1><p>${message}</p><p class="sub"><a href="/admin">Back to projects</a></p></div></div>`,
    { loggedIn: false },
  );
}

function banner(text: Html | string, kind: 'warn' | 'err' | 'ok' = 'warn'): Html {
  return html`<div class="banner${kind === 'warn' ? '' : ` ${kind}`}">${text}</div>`;
}

export type FailedStatus = { repo: string; error: string };

export type Shown = { title: string; secret: string; note: string };

function shownBanner(n: Shown): Html {
  return html`<div class="secret" role="status"><strong>${n.title}</strong><code>${n.secret}</code><div class="mut">${n.note}</div></div>`;
}

export function projectsPage(
  projects: ProjectRow[],
  revokedAgents: AgentRow[],
  notifyUrl: string | null,
  /** null: the GitHub App is not configured, so no status is sent and there are no write failures. */
  failures: FailedStatus[] | null,
  extra: { error?: string; notice?: string; tz?: string; nonce?: string; reload?: boolean; now?: string } = {},
): Html {
  useZone(extra.tz, extra.now, extra.reload);
  return layout(
    'Echo projects',
    html`<div class="head"><h1>Projects</h1></div>
${extra.error ? banner(extra.error, 'err') : ''}${extra.notice ? banner(extra.notice, 'ok') : ''}
${notifyUrl ? '' : banner('No notify_url is set, so Echo cannot alert you when an agent or merge needs your attention. Set it in the owner settings.')}
${failures === null
      ? banner('The GitHub App is not set up, so Echo sends no echo/hold status to GitHub. The hook still refuses held and unapproved merges on machines where it is installed, but merges through the GitHub website or API are not blocked. To turn statuses on, follow "Create the GitHub App" in docs/setup.md; queued statuses are sent by the next cron runs after its secrets are set.')
      : failures.map((f) => banner(html`The last GitHub status write failed for <strong>${f.repo}</strong>: ${f.error}`, 'err'))}
<div class="cols"><section class="panel"><div class="ph"><h2>All projects ${count(projects.length)}</h2></div>
${projects.length
      ? html`<ul class="plain projects">${projects.map(
          (p) => html`<li><a href="/admin/p/${p.id}">${p.name}</a>${p.archived_at ? html` ${badge('archived', 'off')}` : ''}
 ${p.approvals_required ? badge('approvals required', 'info') : html`<span class="mut">no approvals</span>`}</li>`,
        )}</ul>`
      : html`<p class="empty">No projects yet. Create one to register repositories and agents.</p>`}</section>
<aside><section class="panel"><h2>New project</h2><form class="row" method="post" action="/admin/projects"><input type="text" name="name" placeholder="Project name" aria-label="Project name" required> <button class="primary">Create project</button></form></section>
<section class="panel"><h2>Owner notifications</h2>
<form method="post" action="/admin/settings/notify-url"><label class="field">Notification address (https, or http for localhost)
<input type="text" name="url" size="50" value="${notifyUrl ?? ''}" placeholder="https://ntfy.sh/your-topic"></label><p class="hint">Leave empty to turn notifications off.</p>
<div class="row"><button class="primary">Save</button></div></form>
<form class="gap-top" method="post" action="/admin/settings/test-notify"><button>Send test notification</button></form></section>
${revokedAgents.length
      ? html`<section class="panel"><div class="ph"><h2>Revoked agents ${count(revokedAgents.length)}</h2></div>
<p class="hint">Deleting a revoked agent is permanent. It works only when no project or record still refers to the agent, so delete its archived projects first.</p>
<table class="tbl"><tbody>${revokedAgents.map(
          (a) => html`<tr><td>${a.name}<div class="sub">revoked ${utc(a.revoked_at)}</div></td><td class="acts">${confirmPost(`/admin/agents/${a.id}/delete`, 'Delete agent', 'Yes, delete this agent permanently')}</td></tr>`,
        )}</tbody></table></section>`
      : ''}</aside></div>`,
    { nonce: extra.nonce },
  );
}

function post(action: string, label: string, fields: Record<string, string> = {}, note = false, cls = ''): Html {
  return html`<form class="inline" method="post" action="${action}">${Object.entries(fields).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}${note ? html`<input type="text" name="note" placeholder="by the owner" size="14" aria-label="Note"> ` : ''}<button${cls ? html` class="${cls}"` : ''}>${label}</button></form>`;
}

const SCHEDULE_TONE: Record<ScheduleRow['status'], Tone> = {
  waiting_approval: 'wait', approved: 'go', window_closed: 'stop', blocked: 'stop', merged: 'off', scheduled: 'info',
};

/** The schedule fragment: also the response of GET /admin/p/:id/schedule. */
export function scheduleFragment(rows: ScheduleRow[], tz?: string, empty = 'No merges scheduled today.'): Html {
  useZone(tz);
  return scheduleTable(rows, empty);
}

/** The headline of a merge: a short summary of its note, with the full text kept in a disclosure and the tooltip. */
function mergeHeadline(title: string, pr?: number | null): Html {
  const full = title.replace(/\s+/g, ' ').trim();
  const { headline, more } = summarizeMergeDetail(full, pr);
  if (headline === full) return html`${full}`;
  // "(more)" is the safety net: the headline left real content out, so a warning the summary missed still signals itself.
  return html`<span title="${full}">${headline}</span><details class="full"><summary>Full note${more ? ' (more)' : ''}</summary><div class="body">${title}</div></details>`;
}

function scheduleTable(rows: ScheduleRow[], empty: string): Html {
  if (!rows.length) return html`<p class="empty">${empty}</p>`;
  return html`<table class="tbl sched"><thead><tr><th>Time</th><th>PR</th><th>Merger</th><th>Importance</th><th>Status</th><th>Approvals</th></tr></thead><tbody>
${rows.map(
    (r) => html`<tr class="t-${SCHEDULE_TONE[r.status] ?? 'info'}${r.isNext ? ' next' : ''}">
<td class="when"><time datetime="${r.startsAt}" title="${r.startsAt}">${fmtTime(r.startsAt, zone) ?? r.startsAt}</time>${r.isNext ? html` ${badge('next', 'info')}` : ''}</td>
<td class="wide" data-label="PR">${r.repo ? html`<span class="ref">${r.repo}#${r.pr}</span><div class="sub">${mergeHeadline(r.title, r.pr)}</div>` : mergeHeadline(r.title)}</td>
<td data-label="Merger">${r.merger ?? html`<span class="mut">none</span>`}</td><td data-label="Importance">${r.importance === 'high' ? html`<strong>high</strong>` : r.importance}</td>
<td data-label="Status">${badge(r.status.replace('_', ' '), SCHEDULE_TONE[r.status] ?? 'info')}</td>
<td class="wide" data-label="Approvals">${r.approvers.length ? r.approvers.map(
      (a) => html`<div class="appr"><span class="who">${a.name}</span> ${badge(a.response ?? 'no response', a.response === 'approved' ? 'go' : a.response === 'objected' ? 'stop' : 'wait')}${
        // No button once the slot's window has closed: the approval would be refused (move the event instead).
        r.status !== 'merged' && r.status !== 'window_closed' && a.response !== 'approved'
          ? html` ${post(`/admin/events/${r.id}/approve`, `Approve for ${a.name}`, { agent: a.name }, false, 'small')}`
          : ''
      }</div>`,
    ) : html`<span class="mut">none</span>`}</td></tr>`,
  )}</tbody></table>`;
}

function holdsSection(holds: HoldView[]): Html {
  const blocking = holds.filter((h) => h.blocksMerge).length;
  return html`<section class="panel" id="holds"><div class="ph"><h2>Open holds ${count(holds.length, blocking ? 'stop' : undefined)}</h2>${
    blocking ? html`<span class="mut">${blocking} stopping a merge now</span>` : ''
  }</div>${
    holds.length
      ? html`<table class="tbl holds"><thead><tr><th>PR</th><th>Reason</th><th>Hold acknowledged</th><th><span class="vh">Actions</span></th></tr></thead><tbody>
${holds.map(
          (h) => html`<tr class="t-${h.kind === 'blocking' ? 'stop' : h.blocksMerge ? 'wait' : 'info'}"><td><span class="ref">${refBreak(h.repo)}#${h.pr}</span><div>${badge(h.kind, h.kind === 'blocking' ? 'stop' : 'info')}</div></td>
<td class="wide" data-label="Reason"><div class="body">${h.reason}</div><div class="sub">placed by ${h.placedBy}, ${utc(h.placedAt)}</div></td>
<td data-label="Hold acknowledged">${h.acknowledged ? html`${badge('yes', 'go')} <span class="who">by ${h.acknowledged.by}</span><div class="sub">${h.acknowledged.note}</div>` : badge('no', 'wait')}<div class="sub">hold message ${h.message.delivered}/${h.message.recipients} delivered, ${h.message.acknowledged}/${h.message.recipients} acknowledged</div></td>
<td class="acts">${post(`/admin/holds/${h.id}/force-ack`, 'Force-acknowledge', {}, true, 'small')}${post(`/admin/holds/${h.id}/release`, 'Release', {}, true, 'small danger')}</td></tr>`,
        )}</tbody></table>`
      : html`<p class="empty">No open holds.</p>`
  }</section>`;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
}

function pendingTone(m: PendingRow): Tone | null {
  if (m.escalatedAt) return 'stop';
  if (m.deferredUntil) return 'defer';
  if (m.requiresAck) return 'wait';
  return null;
}

function messagesSection(rows: PendingRow[], now: string): Html {
  return html`<section class="panel" id="messages"><div class="ph"><h2>Waiting messages ${count(rows.length, rows.some((m) => m.escalatedAt) ? 'stop' : rows.length ? 'wait' : undefined)}</h2>${
    rows.length ? html`<span class="mut">one row per recipient</span>` : ''
  }</div>${
    rows.length
      ? html`<table class="tbl msgs"><thead><tr><th>#</th><th>Message</th><th>To</th><th>State</th><th><span class="vh">Actions</span></th></tr></thead><tbody>
${rows.map((m) => {
          const tone = pendingTone(m);
          return html`<tr${tone ? html` class="t-${tone}"` : ''}><td class="num">#${m.messageId}</td><td class="wide" data-label="Message"><div class="body">${m.body}</div><div class="sub">from <span class="who">${m.from}</span>, sent ${utc(m.sentAt)}, waiting ${duration(minutesBetween(m.sentAt, now))}</div></td>
<td class="to" data-label="To"><span class="who">${m.recipient}</span><div class="sub">last check-in ${utc(m.lastCheckedInAt)}</div></td>
<td class="wide" data-label="State"><div>${m.deliveredAt ? badge('delivered, not acknowledged', 'wait') : m.requiresAck ? badge('not delivered', 'wait') : html`${badge('not delivered', 'off')}<div class="sub">no acknowledgment needed</div>`}</div>${
            m.deferredUntil ? html`<div class="sub">${badge('deferred', 'defer')} until ${utc(m.deferredUntil)}${m.deferReason ? html` (${m.deferReason})` : ''}</div>` : ''
          }${m.escalatedAt ? html`<div class="sub">${badge('escalated', 'stop')} ${utc(m.escalatedAt)}</div>` : m.escalateAt ? html`<div class="sub">escalates ${utc(m.escalateAt)}</div>` : ''}</td>
<td class="acts">${m.requiresAck ? post(`/admin/messages/${m.messageId}/force-ack`, 'Force-acknowledge', { agent: String(m.recipientId) }, false, 'small') : ''}${post(`/admin/messages/${m.messageId}/withdraw`, 'Withdraw', {}, false, 'small danger')}</td></tr>`;
        })}</tbody></table>`
      : html`<p class="empty">Nothing waiting.</p>`
  }</section>`;
}

/** The key of a data.* change, from its data (subject_id is an INTEGER column and can mangle a numeric-looking key). */
function dataKey(c: Change): string | null {
  if (!c.kind.startsWith('data.')) return null;
  const k = (c.data as { key?: unknown } | null)?.key;
  return typeof k === 'string' ? k : null;
}

function sideColumn(projectId: number, agents: AgentRow[], todos: Todo[], changes: Change[]): Html {
  return html`<aside>
<section class="panel"><h2>Agents</h2><ul class="plain">${agents.map(
    (a) => html`<li><span class="who">${a.name}</span>${a.revoked_at ? html` ${badge('revoked', 'stop')}` : ''}<div class="sub">${a.last_checked_in_at ? html`checked in ${utc(a.last_checked_in_at)}` : 'never checked in'}</div></li>`,
  )}</ul>${agents.length ? '' : html`<p class="empty">No agents yet.</p>`}</section>
<section class="panel"><h2>Open to-dos ${count(todos.length)}</h2>${todos.length ? html`<ul class="plain">${todos.map(
    (t) => html`<li>${t.title}${t.claimedBy ? html`<div class="sub">claimed by ${t.claimedBy}</div>` : ''}</li>`,
  )}</ul>` : html`<p class="empty">None.</p>`}</section>
<section class="panel"><h2>Recent changes</h2>${changes.length ? html`<ul class="plain">${changes.map(
    (c) => html`<li class="change"><b>${c.kind}</b>${dataKey(c) !== null ? html` <a class="ref" href="/admin/p/${projectId}/data/entry?key=${encodeURIComponent(dataKey(c)!)}">${visible(dataKey(c)!)}</a>` : ''}<div class="sub">${visible(c.actor)}, ${utc(c.at)}</div>${c.data ? html`<div class="data">${visible(JSON.stringify(c.data).slice(0, 160))}</div>` : ''}</li>`,
  )}</ul>` : html`<p class="empty">No changes yet.</p>`}</section></aside>`;
}

/** What needs the owner, from the data already on the page. Today's merges load separately and show their own states. */
function situation(holds: HoldView[], messages: PendingRow[]): Html {
  const blocking = holds.filter((h) => h.kind === 'blocking').length;
  const advisory = holds.filter((h) => h.kind !== 'blocking' && h.blocksMerge).length;
  const awaiting = messages.filter((m) => m.requiresAck).length;
  const escalated = messages.filter((m) => m.escalatedAt).length;
  const deferred = messages.filter((m) => m.deferredUntil).length;
  const items: Html[] = [];
  const item = (n: number, one: string, many: string, tone: Tone, href: string) => {
    if (n) items.push(html`<li><a class="t-${tone}" href="${href}"><b>${n}</b>${n === 1 ? one : many}</a></li>`);
  };
  item(blocking, 'blocking hold', 'blocking holds', 'stop', '#holds');
  item(escalated, 'escalated message', 'escalated messages', 'stop', '#messages');
  item(awaiting, 'awaiting acknowledgment', 'awaiting acknowledgment', 'wait', '#messages');
  item(deferred, 'deferred', 'deferred', 'defer', '#messages');
  item(advisory, 'advisory hold not acknowledged', 'advisory holds not acknowledged', 'wait', '#holds');
  return items.length
    ? html`<ul class="situation" aria-label="Needs attention">${items}</ul>`
    : html`<ul class="situation"><li><span class="t-go">No open holds and no waiting messages.</span></li></ul>`;
}

export type ProjectPageData = {
  project: ProjectRow;
  holds: HoldView[];
  messages: PendingRow[];
  agents: AgentRow[];
  todos: Todo[];
  changes: Change[];
  now: string;
  nonce: string;
  tz: string;
  reload?: boolean;
  /** The merges of the chosen day, the seven day choices, and which one is shown. */
  schedule: ScheduleRow[];
  days: DayOption[];
  day: DayOption;
  error?: string;
};

function projectHead(project: ProjectRow, active: Section | ''): Html {
  return html`<p class="crumb"><a href="/admin">All projects</a></p><div class="head"><h1>${project.name}</h1>${
    project.archived_at ? badge('archived', 'off') : ''
  }${project.approvals_required ? badge(`approvals required, ${project.approval_window_min} min window`, 'info') : html`<span class="mut">no approvals</span>`}</div>
${nav(project.id, active)}`;
}

function dayPicker(projectId: number, days: DayOption[], day: DayOption): Html {
  return html`<form class="inline daypick" method="get" action="/admin/p/${projectId}#merges"><label>Day <select name="day" data-autosubmit aria-label="Day">${days.map(
    (o) => html`<option value="${o.value}"${o.value === day.value ? html` selected` : ''}>${o.label}</option>`,
  )}</select></label><noscript> <button class="small">Show</button></noscript></form>`;
}

export function projectPage(d: ProjectPageData): Html {
  useZone(d.tz, d.now, d.reload);
  return layout(
    `Echo ${d.project.name}`,
    html`${projectHead(d.project, '')}
${d.error ? banner(d.error, 'err') : ''}
${situation(d.holds, d.messages)}
<div class="layout"><div>
<section class="panel" id="merges"><div class="ph"><h2>${d.day.today ? "Today's merges" : html`Merges on ${d.day.label}`}</h2>${dayPicker(d.project.id, d.days, d.day)}<span class="mut">times in ${d.tz.replace(/_/g, ' ')}</span></div><div id="schedule">${scheduleTable(d.schedule, d.day.today ? 'No merges scheduled today.' : `No merges scheduled on ${d.day.label}.`)}</div></section>
${holdsSection(d.holds)}
${messagesSection(d.messages, d.now)}
</div>${sideColumn(d.project.id, d.agents, d.todos, d.changes)}</div>`,
    { nonce: d.nonce },
  );
}

// ---------------------------------------------------------------- project sub-pages

export type Section = 'messages' | 'todos' | 'calendar' | 'scratchpad' | 'documents' | 'data' | 'agents' | 'repos' | 'webhooks' | 'settings';
const SECTION_LABEL: Record<Section, string> = {
  messages: 'Messages', todos: 'To-dos', calendar: 'Calendar', scratchpad: 'Scratchpad', documents: 'Documents', data: 'Shared data',
  agents: 'Agents and tokens', repos: 'Repositories', webhooks: 'Webhooks', settings: 'Settings',
};

function nav(projectId: number, active: Section | ''): Html {
  const tab = (href: string, on: boolean, label: string) =>
    html`<a href="${href}" class="${on ? 'on' : ''}"${on ? html` aria-current="page"` : ''}>${label}</a>`;
  return html`<nav class="tabs" aria-label="Project sections">${tab(`/admin/p/${projectId}`, active === '', 'Overview')}${(Object.keys(SECTION_LABEL) as Section[]).map(
    (k) => tab(`/admin/p/${projectId}/${k}`, active === k, SECTION_LABEL[k]),
  )}</nav>`;
}

/** A POST form that needs the owner to tick a box first (delete, clear, revoke, archive), behind a disclosure button. */
function confirmPost(action: string, label: string, what: string, fields: Record<string, string> = {}, open = false): Html {
  return html`<details class="confirm"${open ? html` open` : ''}><summary class="btn small danger">${label}</summary><form method="post" action="${action}">${Object.entries(fields).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}<label><input type="checkbox" name="confirm" value="yes"> ${what}</label> <button class="small danger">${label}</button></form></details>`;
}

/** What the Shared data pages show; the route does the reading and the diffing, the view only renders. */
export type DataPage =
  | { view: 'list'; list: AdminList; prefix: string; deleted: boolean }
  | { view: 'entry'; v: AdminEntryView; valuePretty: string | null }
  | { view: 'version'; v: AdminVersionView; body: { kind: 'diff'; lines: DiffLine[] } | { kind: 'raw'; why: string; now: string | null; before: string | null } };

export type SectionData =
  | { section: 'messages'; lines: MessageLine[] }
  | { section: 'todos'; todos: Todo[] }
  | { section: 'calendar'; events: EventView[]; hidden: number; showAll: boolean }
  | { section: 'scratchpad'; entries: ScratchEntry[] }
  | { section: 'documents'; docs: { info: DocumentInfo; versions: number[] }[]; open?: Document; rawOnly?: boolean }
  | { section: 'data'; page: DataPage }
  | { section: 'agents'; members: AgentRow[]; others: AgentRow[] }
  | { section: 'repos'; repos: RepoStatusRow[] }
  | { section: 'webhooks'; hooks: WebhookInfo[] }
  | { section: 'settings' };

function recipientLine(r: MessageLine['recipients'][number], requiresAck: boolean): Html {
  const state = r.ackedAt
    ? html`${badge('acknowledged', 'go')} <span class="sub">${utc(r.ackedAt)}${r.ackedBy ? html` by ${r.ackedBy}` : ''}</span>`
    : r.deliveredAt
      ? html`${badge('delivered', 'info')} <span class="sub">${utc(r.deliveredAt)}</span>`
      : badge('not delivered', requiresAck ? 'wait' : 'off');
  return html`<div class="rcpt"><span class="who">${r.name}</span> ${state}${
    r.deferredUntil ? html`<div class="sub">${badge('deferred', 'defer')} until ${utc(r.deferredUntil)}</div>` : ''
  }${r.escalatedAt ? html`<div class="sub">${badge('escalated', 'stop')} ${utc(r.escalatedAt)}</div>` : ''}</div>`;
}

function messageTone(m: MessageLine): Tone | null {
  if (m.withdrawnAt) return 'off';
  if (m.recipients.some((r) => r.escalatedAt && !r.ackedAt)) return 'stop';
  if (m.requiresAck && m.recipients.some((r) => !r.ackedAt)) return m.recipients.some((r) => r.deferredUntil && !r.ackedAt) ? 'defer' : 'wait';
  return null;
}

function panel(inner: Html, cls = ''): Html {
  return html`<section class="panel${cls ? ` ${cls}` : ''}">${inner}</section>`;
}

function sectionBody(project: ProjectRow, d: SectionData): Html {
  const base = `/admin/p/${project.id}`;
  // The Calendar's Show all view rides along in the URL of its own forms, so a refusal re-renders the same view.
  const keep = d.section === 'calendar' && d.showAll ? '?show=all' : '';
  switch (d.section) {
    case 'messages':
      return panel(d.lines.length
        ? html`<table class="tbl"><thead><tr><th>#</th><th>From</th><th>Message</th><th>Recipients</th></tr></thead><tbody>${d.lines.map((m) => {
            const tone = messageTone(m);
            return html`<tr class="${tone ? `t-${tone}` : ''}${m.withdrawnAt ? ' dim' : ''}"><td class="num">#${m.id}</td><td data-label="From"><span class="who">${m.from}</span><div class="sub">${m.kind}${m.requiresAck ? ', needs acknowledgment' : ''}</div></td>
<td class="wide" data-label="Message"><div class="body">${m.body}</div><div class="sub">sent ${utc(m.sentAt)}${m.withdrawnAt ? html`, ${badge('withdrawn', 'off')} ${utc(m.withdrawnAt)}` : ''}</div></td>
<td class="wide" data-label="Recipients">${m.recipients.map((r) => recipientLine(r, m.requiresAck))}</td></tr>`;
          })}</tbody></table>`
        : html`<p class="empty">No messages.</p>`);
    case 'todos':
      return panel(d.todos.length
        ? html`<table class="tbl"><thead><tr><th>#</th><th>Title</th><th>State</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${d.todos.map(
            (t) => html`<tr class="${t.doneAt ? 't-go dim' : t.claimedBy ? 't-info' : ''}"><td class="num">#${t.id}</td><td class="wide" data-label="Title"><form class="row" method="post" action="${base}/todos/${t.id}/edit"><input type="text" name="title" value="${t.title}" size="40" aria-label="Title of to-do ${t.id}"> <button class="small">Save</button></form></td>
<td data-label="State">${t.doneAt ? html`${badge('done', 'go')}<div class="sub">${utc(t.doneAt)}</div>` : t.claimedBy ? html`${badge('claimed', 'info')}<div class="sub">by ${t.claimedBy}</div>` : badge('open', 'off')}<div class="sub">added by ${t.addedBy}</div></td>
<td class="acts">${t.claimedBy && !t.doneAt ? post(`${base}/todos/${t.id}/clear-claim`, 'Clear claim', {}, false, 'small') : ''}${confirmPost(`${base}/todos/${t.id}/delete`, 'Delete', 'Yes, delete this to-do')}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">No to-dos.</p>`);
    case 'calendar':
      return html`${panel(html`<form method="post" action="${base}/events${keep}"><h3>Add an event</h3>
<div class="fields"><label class="field grow">Title <input type="text" name="title" placeholder="Title" required></label>
<label class="field">Starts at, with a zone <input type="text" name="starts_at" placeholder="2026-12-01T21:00:00-06:00" size="28" required></label>
<label class="field">Importance <select name="importance"><option>normal</option><option>low</option><option>high</option></select></label></div>
<p class="hint">The time needs a zone (Z or an offset). For a merge, also give the repository and PR; approvers are agent names, comma separated.</p>
<div class="fields"><label class="field grow">Repository <input type="text" name="repo" placeholder="owner/name"></label> <label class="field">PR <input type="text" name="pr" placeholder="PR" size="5"></label>
<label class="field">Merging agent <input type="text" name="merger" placeholder="Merging agent"></label>
<label class="field grow">Approvers <input type="text" name="approvers" placeholder="Approvers"></label></div><button class="primary">Add event</button></form>`)}
${panel(html`<p class="sub">${d.showAll
        ? html`Showing every entry. <a href="${base}/calendar">Show pending only</a>`
        : html`${d.hidden} past or closed ${d.hidden === 1 ? 'entry' : 'entries'} hidden. <a href="${base}/calendar?show=all">Show all</a>`}</p>`)}
${panel(d.events.length
        ? html`<table class="tbl"><thead><tr><th>When</th><th>Event</th><th>State</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${d.events.map(
            (e) => html`<tr class="${e.cancelled ? 't-off dim' : e.mergedAt ? 't-off' : 't-info'}"><td>${utc(e.startsAt)}<div class="sub">entered as ${e.enteredAs}</div></td>
<td class="wide" data-label="Event">${e.title}${e.repo ? html` <span class="ref">${e.repo}#${e.pr}</span>${e.merger ? html`<span class="mut">, merger ${e.merger}</span>` : ''}` : ''}<div class="sub">${e.importance === 'high' ? html`<strong>high</strong>` : e.importance}, by ${e.createdBy}</div></td>
<td data-label="State">${e.cancelled ? badge('cancelled', 'off') : e.mergedAt ? html`${badge('merged', 'off')}<div class="sub">${utc(e.mergedAt)}</div>` : badge('scheduled', 'info')}</td>
<td class="acts">${e.cancelled || e.mergedAt
              ? ''
              : html`<form class="inline" method="post" action="${base}/events/${e.id}/move${keep}"><input type="text" name="starts_at" placeholder="new time with zone" size="26" aria-label="New time"> <button class="small">Move</button></form>
${post(`${base}/events/${e.id}/cancel${keep}`, 'Cancel event', {}, false, 'small danger')}`}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">${d.showAll ? 'No events.' : 'No pending events.'}</p>`)}`;
    case 'scratchpad':
      return d.entries.length
        ? html`<ol class="notes">${d.entries.map(
            (e) => html`<li class="panel"><div class="meta">#${e.id}, <span class="who">${e.author}</span>, ${utc(e.createdAt)}${e.editedAt ? html`, edited ${utc(e.editedAt)}` : ''}</div>
<form method="post" action="${base}/scratchpad/${e.id}/edit"><textarea name="body" aria-label="Entry ${e.id}">${e.body}</textarea> <button class="small">Save entry</button></form></li>`,
          )}</ol>${panel(html`<h3>Clear the scratchpad</h3><p class="hint">Deletes every entry for every agent in this project.</p>${confirmPost(`${base}/scratchpad/clear`, 'Clear scratchpad', 'Yes, delete every entry')}`, 'danger-zone')}`
        : panel(html`<p class="empty">The scratchpad is empty.</p>`);
    case 'documents':
      return html`${d.open
        ? html`<section class="panel"><div class="ph"><h2>${d.open.name}, version ${d.open.version}</h2></div><p class="sub">${d.open.format}, saved by ${d.open.savedBy} at ${utc(d.open.createdAt)}</p>${docBody(d.open, d.rawOnly === true, base)}</section>`
        : ''}
${panel(d.docs.length
        ? html`<table class="tbl"><thead><tr><th>Name</th><th>Versions</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${d.docs.map(
            (x) => html`<tr><td><a class="ref" href="${base}/documents/${encodeURIComponent(x.info.name)}${d.rawOnly && d.open && d.open.name === x.info.name ? '?raw=1' : ''}">${x.info.name}</a>${isMarkdownDoc(x.info) ? html` <a class="rawlink" href="${base}/documents/${encodeURIComponent(x.info.name)}?raw=1">raw</a>` : ''}<div class="sub">${x.info.format}, latest by ${x.info.savedBy}, ${utc(x.info.createdAt)}</div></td>
<td class="wide" data-label="Versions"><div class="vers">${x.versions.map((v) => html`<a href="${base}/documents/${encodeURIComponent(x.info.name)}?version=${v}${d.rawOnly && d.open && d.open.name === x.info.name ? '&raw=1' : ''}" class="${d.open && d.open.name === x.info.name && d.open.version === v ? 'on' : ''}">v${v}</a> `)}</div></td>
<td class="acts">${confirmPost(`${base}/documents/delete`, 'Delete', 'Yes, delete every version', { name: x.info.name })}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">No documents.</p>`)}`;
    case 'data':
      return dataSection(base, d.page);
    case 'agents':
      return html`<div class="pair">${panel(html`<form method="post" action="${base}/agents"><h3>New agent</h3><div class="row"><input type="text" name="name" placeholder="Agent name" aria-label="Agent name" required> <button class="primary">Create agent</button></div>
<p class="hint gap-top">Its token is shown once, on the next page.</p></form>`)}
${d.others.length
        ? panel(html`<form method="post" action="${base}/agents/assign"><h3>Assign an existing agent</h3><div class="row"><select name="agent" aria-label="Agent">${d.others.map(
            (a) => html`<option value="${a.id}">${a.name}</option>`,
          )}</select> <button>Assign</button></div></form>`)
        : ''}</div>
${panel(html`<h3>Agents in this project</h3>${d.members.length
        ? html`<table class="tbl agents"><thead><tr><th>Name</th><th>State</th><th>Last check-in</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${d.members.map(
            (a) => html`<tr><td>${a.name}</td><td data-label="State">${a.revoked_at ? html`${badge('revoked', 'stop')}<div class="sub">${utc(a.revoked_at)}</div>` : badge('active', 'go')}</td><td data-label="Last check-in">${utc(a.last_checked_in_at)}</td>
<td class="acts">${confirmPost(`${base}/agents/${a.id}/reissue`, a.revoked_at ? 'Reissue token (re-enables this agent)' : 'Reissue token', 'Yes, the old token stops working now')}${post(`${base}/agents/${a.id}/unassign`, 'Remove from project', {}, false, 'small')}
${a.revoked_at ? html`<div class="sub">Delete it from the admin home once its projects are deleted.</div>` : confirmPost(`${base}/agents/${a.id}/revoke`, 'Revoke', 'Yes, revoke this token')}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">No agents.</p>`}`)}`;
    case 'repos':
      return html`${project.archived_at
        ? panel(html`<p class="empty">This project is archived, so repositories cannot be added.</p>`)
        : panel(html`<form class="row" method="post" action="${base}/repos"><input type="text" name="repo" placeholder="owner/name" aria-label="Repository" required> <button class="primary">Add repository</button></form>`)}
${panel(d.repos.length
        ? html`<table class="tbl"><thead><tr><th>Repository</th><th>GitHub App</th><th>Last status write</th><th>Last error</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${d.repos.map(
            (r) => html`<tr class="${r.lastError ? 't-stop' : !r.installed ? 't-wait' : ''}"><td><span class="ref">${r.fullName}</span></td><td data-label="GitHub App">${badge(`App installed: ${r.installed ? 'yes' : 'no'}`, r.installed ? 'go' : 'wait')}</td>
<td data-label="Last status write">${r.statusAt ? html`${utc(r.statusAt)}<div>${badge(r.statusState ?? 'not confirmed', r.statusState === 'success' ? 'go' : r.statusState === 'failure' || r.statusState === 'error' ? 'stop' : 'info')}</div>` : html`<span class="mut">none yet</span>`}</td>
<td class="wide" data-label="Last error">${r.lastError ? html`<span class="err-text">${r.lastError}</span>` : html`<span class="mut">none</span>`}</td><td class="acts">${confirmPost(`${base}/repos/${r.id}/remove`, 'Remove', 'Yes. Echo stops checking merges in this repository. If echo/hold is a required check in GitHub, remove it from the branch rules too, or open PRs keep their last status. A repository with open holds or open merge events cannot be removed: release the holds and cancel the merge events first.')}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">No repositories registered.</p>`)}`;
    case 'webhooks':
      return html`${panel(html`<form method="post" action="${base}/webhooks"><div class="row"><input type="text" name="url" placeholder="https://example.com/hook" size="40" aria-label="Webhook URL" required> <button class="primary">Add webhook</button></div>
<p class="hint gap-top">The signing secret is shown once, on the next page.</p></form>`)}
${panel(d.hooks.length
        ? html`<table class="tbl"><thead><tr><th>URL</th><th>Added</th><th>Last error</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${d.hooks.map(
            (h) => html`<tr class="${h.disabledAt ? 't-off dim' : h.lastError ? 't-stop' : 't-go'}"><td><code>${h.url}</code>${h.disabledAt ? html`<div class="sub">${badge('removed', 'off')} ${utc(h.disabledAt)}</div>` : ''}</td><td data-label="Added">${utc(h.createdAt)}</td><td class="wide" data-label="Last error">${h.lastError ? html`<span class="err-text">${h.lastError}</span>` : html`<span class="mut">none</span>`}</td>
<td class="acts">${h.disabledAt ? '' : post(`${base}/webhooks/${h.id}/remove`, 'Remove', {}, false, 'small danger')}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">No webhooks.</p>`)}`;
    case 'settings':
      return html`<div class="pair"><section class="panel"><h3>Merge approvals</h3><form method="post" action="${base}/settings">
<label class="check"><input type="checkbox" name="approvals" value="on" ${project.approvals_required ? 'checked' : ''}> Approvals required before a merge</label>
<p><label class="field">Approval window, minutes either side (5 to 240) <input type="text" name="window" value="${project.approval_window_min}" size="4"></label></p>
<button class="primary">Save settings</button></form></section>
<section class="panel"><h3>Rename</h3><form class="row" method="post" action="${base}/rename"><input type="text" name="name" value="${project.name}" aria-label="Project name" required> <button>Rename</button></form></section></div>
<section class="panel danger-zone"><h3>Archive</h3>${project.archived_at
        ? html`<p class="mut">Archived ${utc(project.archived_at)}.</p>
<p>Deleting permanently removes the project and all its messages, holds, calendar, to-dos, scratchpad, documents and log. This cannot be undone.</p>
${confirmPost(`${base}/delete`, 'Delete permanently', 'Yes, delete this project and everything in it')}`
        : html`<p>Archiving keeps all data. The project disappears from whoami, the MCP tools and the hooks. A project that still has registered repositories cannot be archived: remove its repositories first, because registered repositories stay gated.</p>
${confirmPost(`${base}/archive`, 'Archive project', 'Yes, archive this project')}`}</section>`;
  }
}

const entryHref = (base: string, key: string) => `${base}/data/entry?key=${encodeURIComponent(key)}`;
const versionHref = (base: string, key: string, v: number) => `${base}/data/version?key=${encodeURIComponent(key)}&v=${v}`;
const kib = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KiB`);

/** A repair form: needs a reason and the confirm box; the hidden version makes a stale click fail. */
function repairForm(action: string, label: string, what: string, key: string, version: number): Html {
  return html`<details class="confirm"><summary class="btn small danger">${label}</summary><form method="post" action="${action}"><input type="hidden" name="key" value="${key}"><input type="hidden" name="version" value="${version}">
<label>Reason (recorded in the history) <input type="text" name="reason" required maxlength="500"></label>
<label><input type="checkbox" name="confirm" value="yes"> ${what}</label> <button class="small danger">${label}</button></form></details>`;
}

function opBadge(op: string): Html {
  return badge(op, op === 'delete' || op === 'admin_delete' ? 'stop' : op === 'admin_release' ? 'wait' : 'info');
}

function dataSection(base: string, page: DataPage): Html {
  if (page.view === 'list') {
    const { list, prefix, deleted } = page;
    const groups = new Map<string, typeof list.rows>();
    for (const r of list.rows) {
      const g = r.key.includes('/') ? r.key.slice(0, r.key.indexOf('/')) : '';
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0));
    const qs = (extra: Record<string, string>) => {
      const q = new URLSearchParams({ ...(prefix ? { prefix } : {}), ...(deleted ? { deleted: '1' } : {}), ...extra }).toString();
      return `${base}/data${q ? `?${q}` : ''}`;
    };
    return html`${panel(html`<p class="sub">${list.live} live key${list.live === 1 ? '' : 's'} (limit 2000). History: ${list.historyRows} version${list.historyRows === 1 ? '' : 's'}, ${kib(list.historyBytes)}.</p>
<form method="get" action="${base}/data" class="row"><input type="text" name="prefix" value="${/^[A-Za-z0-9._:/-]*$/.test(prefix) ? prefix : ''}" placeholder="Key prefix, for example rulings/" aria-label="Key prefix" maxlength="200"> <label><input type="checkbox" name="deleted" value="1"${deleted ? html` checked` : ''}> show deleted</label> <button class="small">Filter</button></form>`)}
${list.rows.length
      ? ordered.map(
          ([g, rows]) => html`<section class="panel">${g ? html`<h3 class="dgroup">${visible(g)}/ ${count(rows.length)}</h3>` : html`<h3 class="dgroup">No namespace ${count(rows.length)}</h3>`}<table class="tbl"><thead><tr><th>Key</th><th>Version</th><th>Owner</th><th>Updated</th><th>Note and value</th></tr></thead><tbody>${rows.map(
            (r) => html`<tr class="${r.deleted ? 'dim' : ''}"><td data-label="Key"><a class="ref" href="${entryHref(base, r.key)}">${visible(r.key)}</a>${r.deleted ? html` ${badge('deleted', 'off')}` : ''}</td><td data-label="Version">v${r.version}</td><td data-label="Owner">${r.owner ? visible(r.owner) : html`<span class="mut">shared</span>`}</td>
<td data-label="Updated"><span class="who">${visible(r.updatedBy)}</span><div class="sub">${utc(r.updatedAt)}</div></td>
<td class="wide" data-label="Note and value">${r.note ? html`<div>${visible(r.note)}</div>` : ''}${r.deleted ? '' : html`<div class="pv">${visible(r.preview)}${r.previewCut ? '\u2026' : ''}</div>`}</td></tr>`,
          )}</tbody></table></section>`,
        )
      : panel(html`<p class="empty">${prefix || deleted ? 'No keys match.' : 'No shared data yet.'}</p>`)}
${list.next ? html`<p><a href="${qs({ after: list.next })}">Next keys</a></p>` : ''}`;
  }
  if (page.view === 'entry') {
    const { v, valuePretty } = page;
    const e = v.entry;
    const repair = e.deleted
      ? ''
      : html`<div class="repair">${e.owner ? repairForm(`${base}/data/release`, 'Release owner', `Yes, release ${visible(e.owner)}'s ownership`, v.key, e.version) : ''}${repairForm(`${base}/data/delete`, 'Delete entry', 'Yes, delete this entry (its history stays)', v.key, e.version)}</div>`;
    return html`<p><a href="${base}/data">All keys</a></p>
<section class="panel"><div class="ph"><h2>${visible(v.key)}</h2></div>
<p class="sub">version ${e.version}${e.deleted ? html` ${badge('deleted', 'off')}` : ''}, ${e.owner ? html`owned by ${visible(e.owner)}` : 'shared'}, updated by ${visible(e.updatedBy)} ${utc(e.updatedAt)}${e.note ? html`, note: ${visible(e.note)}` : ''}</p>
${e.valueText === null
      ? html`<p class="empty">Deleted. The history below is kept.</p>`
      : valuePretty !== null
        ? html`<pre>
${visible(valuePretty)}</pre>`
        : html`<p class="hint">Too large to pretty-print; showing the stored text.</p><pre>
${visible(e.valueText)}</pre>`}
${repair}</section>
${panel(html`<h3>History</h3><table class="tbl"><thead><tr><th>Version</th><th>Change</th><th>By</th><th>Note</th></tr></thead><tbody>${v.history.map(
      (h) => html`<tr><td data-label="Version"><a class="ref" href="${versionHref(base, v.key, h.version)}">v${h.version}</a></td><td data-label="Change">${opBadge(h.op)}${h.batchId ? html` <span class="sub">batch ${h.batchId.slice(0, 8)}</span>` : ''}</td><td data-label="By"><span class="who">${visible(h.actor)}</span><div class="sub">${utc(h.at)}</div></td><td class="wide" data-label="Note">${h.note ? visible(h.note) : ''}</td></tr>`,
    )}</tbody></table>${v.older ? html`<p><a href="${entryHref(base, v.key)}&before=${v.older}">Older versions</a></p>` : ''}`)}`;
  }
  const { v, body } = page;
  const key = v.key;
  return html`<p><a href="${entryHref(base, key)}">${visible(key)}</a>${v.prevVersion !== null ? html`, <a href="${versionHref(base, key, v.version - 1)}">previous (v${v.version - 1})</a>` : ''}${v.version < v.latest ? html`, <a href="${versionHref(base, key, v.version + 1)}">next (v${v.version + 1})</a>` : ''}</p>
<section class="panel"><div class="ph"><h2>${visible(key)}, version ${v.version}</h2></div>
<p class="sub">${opBadge(v.op)} by ${visible(v.actor)} ${utc(v.at)}${v.owner ? html`, owner ${visible(v.owner)}` : ', shared'}${v.note ? html`, note: ${visible(v.note)}` : ''}${v.batchId ? html`, batch ${v.batchId}` : ''}</p>
${body.kind === 'diff'
    ? html`${v.valueText !== null && pretty(v.valueText) !== null ? html`<h3>Value</h3><pre>
${visible(pretty(v.valueText)!)}</pre>` : html`<p class="empty">This version has no value (a delete).</p>`}<h3>Changes from the previous version</h3>${body.lines.length ? '' : html`<p class="empty">No change in the value.</p>`}<div class="diff panel">${body.lines.map((l) => html`<div class="${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === ' ' ? '' : 'gap'}">${l.t === ' ' ? '  ' : l.t === '\u2026' ? '' : `${l.t} `}${l.text}</div>`)}</div>`
    : html`<p class="hint">${body.why}</p>${body.now !== null ? html`<h3>This version</h3><pre>
${visible(body.now)}</pre>` : html`<p class="empty">This version has no value (a delete).</p>`}${body.before !== null ? html`<details><summary>Previous version</summary><pre>
${visible(body.before)}</pre></details>` : ''}`}</section>`;
}

export function sectionPage(d: { project: ProjectRow; data: SectionData; error?: string; shown?: Shown; tz?: string; nonce?: string; now?: string; reload?: boolean }): Html {
  useZone(d.tz, d.now, d.reload);
  const label = SECTION_LABEL[d.data.section];
  return layout(
    `Echo ${d.project.name} ${label}`,
    html`${projectHead(d.project, d.data.section)}
<h2 class="page-title">${label}</h2>${d.error ? banner(d.error, 'err') : ''}${d.shown ? shownBanner(d.shown) : ''}
${sectionBody(d.project, d.data)}`,
    { nonce: d.nonce },
  );
}
