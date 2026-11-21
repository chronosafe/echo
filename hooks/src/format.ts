import type { PrTarget } from './resolve-pr';

export type HoldBlock = {
  id: number;
  kind: 'blocking' | 'advisory';
  reason: string;
  placedBy: string;
  placedAt: string;
};
export type Block =
  | { kind: 'hold'; hold: HoldBlock }
  | { kind: 'no_slot' }
  | { kind: 'approval_missing'; eventId: number; startsAt: string; missing: string[] }
  | { kind: 'outside_window'; eventId: number; startsAt: string; windowStart: string; windowEnd: string };

const name = (t: PrTarget): string => `${t.repo}#${t.pr}`;

export function blocked(t: PrTarget, blocks: Block[]): string {
  const lines = blocks.map((b) => {
    switch (b.kind) {
      case 'hold': {
        const h = b.hold;
        const kind = h.kind === 'blocking' ? 'Blocking' : 'Advisory';
        const how =
          h.kind === 'blocking'
            ? `Only ${h.placedBy} or the owner can release it; echo_ack_hold tells ${h.placedBy} you have seen it.`
            : `Clear it with echo_ack_hold (hold_id=${h.id}, note required).`;
        return `- ${kind} hold ${h.id} by ${h.placedBy} at ${h.placedAt}: ${h.reason}. ${how}`;
      }
      case 'no_slot':
        return '- No approved merge slot. Schedule it with echo_calendar_add (kind merge) and wait for approval.';
      case 'approval_missing':
        // No names: the event has no approval requests at all (approvals turned on after it was added, or nobody
        // else in the project could be asked). A move sends them.
        return b.missing.length
          ? `- Waiting for approval from ${b.missing.join(', ')} for the ${slotText(b.startsAt)} slot.`
          : `- No approvers were asked for the ${slotText(b.startsAt)} slot; move the event (echo_calendar_update) to send requests, or ask the owner.`;
      case 'outside_window':
        return `- Outside the approved window for the ${slotText(b.startsAt)} slot (${slotText(b.windowStart)} to ${slotText(b.windowEnd)}). Reschedule and get approval again.`;
    }
  });
  return [
    `Merge refused by Echo: ${name(t)} cannot merge now.`,
    ...lines,
    'If you are a subagent, do not merge: report this to your orchestrator.',
  ].join('\n');
}

/** The service stores times with milliseconds; agents read them without. */
const slotText = (iso: string): string => iso.replace(/\.\d{3}Z$/, 'Z');

export function unreachable(t: PrTarget, detail: string): string {
  return `Merge refused: the Echo service could not be reached (${detail}), and ${t.repo} is a registered repository, so merges are blocked until Echo answers. A human can allow this one merge, once, within 30 minutes, by restarting Claude Code with ECHO_MERGE_OVERRIDE=${name(t)} in its environment.`;
}

export function flagRefused(t: PrTarget, flag: '--auto' | '--admin'): string {
  return `Merge refused by Echo: ${flag} is not allowed in ${t.repo}. ${
    flag === '--auto'
      ? 'Auto-merge and merge queues let GitHub merge later without checking holds or approvals.'
      : '--admin skips required checks, including echo/hold.'
  } Merge directly without it.`;
}

export function ambiguousMerge(why: string): string {
  return `Merge refused: Echo could not tell exactly what this command merges. ${why} Run the merge as its own command, \`[cd DIR && ]gh pr merge <number> [-R owner/name] [flags]\`. If the command was not meant to merge, keep any mention of the phrase inside the quoted message of a separate \`echo\`, \`grep\` or \`git commit\` command.`;
}

export function cannotResolve(detail: string, named?: PrTarget): string {
  if (named) {
    return `Merge refused: gh could not find ${named.repo}#${named.pr} (${detail}). Check the repository name and number, and that gh is logged in with access to it (\`gh auth status\`).`;
  }
  return `Merge refused: Echo could not work out which pull request this command merges (${detail}). Name the pull request explicitly, for example \`gh pr merge <number> -R owner/name\`, from a directory inside the repository, and try again.`;
}

export function overrideUsed(key: string): string {
  return `Merge refused: the emergency override for ${key} was already used once and cannot be used again. Wait for Echo to answer again; if the outage is long, a human can remove echo/hold from the repository's required checks on GitHub.`;
}

export function overrideExpired(key: string): string {
  return `Merge refused: the emergency override for ${key} expired, because more than 30 minutes have passed since Claude Code was started with it. Wait for Echo to answer again; if the outage is long, a human can remove echo/hold from the repository's required checks on GitHub.`;
}

export function overrideAllowed(key: string): string {
  return `Echo is unreachable, so the emergency override ECHO_MERGE_OVERRIDE=${key} was used to allow this one merge. It cannot be used again, and the use will be reported to Echo.`;
}

export function queuedDisabled(t: PrTarget): string {
  return `${name(t)} was not merged immediately, so GitHub queued it to merge later without Echo checking it. Echo turned auto-merge back off with gh pr merge --disable-auto. Merge it directly once Echo allows it.`;
}

export function noToken(agent: string): string {
  return `Merge refused: no Echo token was found for ${agent} (from ECHO_AGENT or the default agent), so Echo cannot check this merge. Store one with \`node ~/.echo/echo-hook.mjs set-token ${agent}\` (the token on stdin) and try again.`;
}

export function notConfigured(): string {
  return 'Merge refused: Echo is not configured on this machine (no readable ~/.echo/config.json), so it cannot check this merge. Run the Echo installer, then try again.';
}

export function hookError(detail: string): string {
  return `Merge refused: the Echo merge check failed inside the hook (${detail}). Try again; if it keeps failing, tell the owner.`;
}

// ---- message hooks. Field names are the service's: see service/src/api/hooks.ts.

export type MessageItem = { messageId: number; from: string; body: string; requiresAck: boolean; sentAt: string };
export type HoldItem = { id: number; repo: string; pr: number; kind: string; reason: string; placedBy: string; placedAt: string };
export type ApprovalItem = { eventId: number; repo: string; pr: number; startsAt: string; merger: string };
export type Orientation = {
  now: string;
  agent: { name: string };
  projects: { name: string }[];
  fresh: MessageItem[];
  awaitingAck: MessageItem[];
  openHolds: HoldItem[];
  pendingApprovals: ApprovalItem[];
};

/** Bodies are written by other agents: a header line Echo controls, then the body indented so it cannot pose as an Echo line. */
function message(m: MessageItem): string {
  const head = `From ${m.from} at ${m.sentAt} (message ${m.messageId}${m.requiresAck ? ', needs acknowledgment' : ''}):`;
  return [head, ...String(m.body).split(/\r\n|\r|\n/).map((l) => `  ${l}`)].join('\n');
}
const section = (title: string, lines: string[]): string[] => (lines.length ? [`${title}:`, ...lines] : []);

export function newMessages(fresh: MessageItem[], awaitingAck: MessageItem[]): string {
  return [...section('New messages', fresh.map(message)), ...section('Awaiting your acknowledgment', awaitingAck.map(message))].join('\n');
}

const REMINDER =
  'Echo: acknowledge messages you have handled with echo_ack_message, or defer with echo_defer_message if you cannot act yet; approve or object to merges with echo_approve_merge / echo_object_merge; a blocking hold stays until its placer releases it; put long content in a document (echo_doc_save).';

export function orientation(o: Orientation): string {
  const holds = o.openHolds.map(
    (h) => `- ${h.kind === 'blocking' ? 'Blocking' : 'Advisory'} hold ${h.id} on ${h.repo}#${h.pr} by ${h.placedBy} at ${h.placedAt}: ${h.reason}`,
  );
  const approvals = o.pendingApprovals.map((a) => `- ${a.repo}#${a.pr} by ${a.merger}, slot ${slotText(a.startsAt)} (event ${a.eventId})`);
  return [
    `You are ${o.agent.name} in Echo. Echo's clock: ${o.now} (UTC); trust it over your own. Projects: ${o.projects.map((p) => p.name).join(', ')}.`,
    newMessages(o.fresh, o.awaitingAck),
    ...section('Merges awaiting your approval', approvals),
    ...section('Open holds', holds),
    REMINDER,
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export function stopBlocked(items: MessageItem[]): string {
  return [
    'These messages need your acknowledgment before you stop:',
    ...items.map(message),
    'Acknowledge each one you have handled. If you cannot act on one yet, defer it with a reason rather than acknowledging it.',
  ].join('\n');
}
