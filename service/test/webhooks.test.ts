import { beforeEach, describe, expect, it } from 'vitest';
import { changesSince } from '../src/domain/changelog';
import { sendMessage } from '../src/domain/messages';
import { addWebhook, deliverWebhooks, removeWebhook } from '../src/domain/webhooks';
import { fakeNet, seed, testCtx } from './helpers';

const ctx = testCtx();
const HOOK = 'https://hooks.test/echo';
let s: Awaited<ReturnType<typeof seed>>;
let projectId: number;

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  projectId = s.project.id;
});

const send = (body: string) => sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body, requiresAck: false });
const row = () =>
  ctx.db.prepare(`SELECT * FROM webhooks`).first<{
    id: number; secret: string; cursor_seq: number; attempts: number; next_attempt_at: string | null; last_error: string | null; disabled_at: string | null;
  }>();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('webhooks', () => {
  it('webhook delivers entries in order with a verifiable signature; skips after 5 failures', async () => {
    await send('before the webhook');
    const { id, secret } = await addWebhook(ctx, projectId, HOOK);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const start = (await row())!;
    expect(start.id).toBe(id);
    expect(start.secret).toBe(secret);

    await send('one');
    await send('two');
    const expected = (await changesSince(ctx, projectId, start.cursor_seq)).filter((c) => c.kind === 'message.sent');
    expect(expected).toHaveLength(2);

    const net = fakeNet();
    await deliverWebhooks(ctx, net.fetch);
    expect(net.requests).toHaveLength(2); // history before creation (and the webhook.added entry) is not sent
    expect(net.requests.map((r) => Number(r.headers['x-echo-seq']))).toEqual(expected.map((c) => c.seq));
    for (const [i, r] of net.requests.entries()) {
      expect(r.url).toBe(HOOK);
      expect(r.method).toBe('POST');
      expect(r.hasSignal).toBe(true);
      expect(r.headers['x-echo-signature']).toBe(`sha256=${await hmacHex(secret, r.body)}`);
      expect(JSON.parse(r.body)).toEqual(expected[i]);
    }
    expect((await row())!.cursor_seq).toBe(expected[1].seq);

    // Entry three fails five times: strict order means nothing after it is sent until it is skipped.
    await send('three');
    await send('four');
    const [three, four] = (await changesSince(ctx, projectId, expected[1].seq)).filter((c) => c.kind === 'message.sent');
    const bad = fakeNet((r) => (r.headers['x-echo-seq'] === String(three.seq) ? 500 : 200));
    const backoffMin = [1, 5, 30, 120];
    for (let i = 0; i < 4; i++) {
      await deliverWebhooks(ctx, bad.fetch);
      const w = (await row())!;
      expect(w.attempts).toBe(i + 1);
      expect(w.cursor_seq).toBe(expected[1].seq);
      expect(w.next_attempt_at).toBe(new Date(Date.parse(ctx.now()) + backoffMin[i] * 60_000).toISOString());
      const before = bad.requests.length;
      await deliverWebhooks(ctx, bad.fetch); // not due yet
      expect(bad.requests).toHaveLength(before);
      ctx.setNow(w.next_attempt_at!);
    }
    expect(bad.requests.map((r) => r.headers['x-echo-seq'])).toEqual(Array(4).fill(String(three.seq)));
    await deliverWebhooks(ctx, bad.fetch); // 5th failure: skipped
    const skipped = (await row())!;
    expect(skipped.cursor_seq).toBe(three.seq);
    expect(skipped.attempts).toBe(0);
    expect(skipped.last_error).toContain('500');
    expect(bad.requests).toHaveLength(5);
    await deliverWebhooks(ctx, bad.fetch);
    expect(bad.requests.at(-1)!.headers['x-echo-seq']).toBe(String(four.seq));
    expect((await row())!.cursor_seq).toBe(four.seq);
  });

  it('the hook and its webhook.added entry exist together, and the cursor equals that entry', async () => {
    await send('earlier');
    const { id } = await addWebhook(ctx, projectId, HOOK);
    const added = (await changesSince(ctx, projectId, 0)).filter((c) => c.kind === 'webhook.added');
    expect(added).toHaveLength(1);
    expect(added[0].subjectId).toBe(id);
    expect((await row())!.cursor_seq).toBe(added[0].seq);
  });

  it('validates the URL and the project', async () => {
    await expect(addWebhook(ctx, projectId, 'not a url')).rejects.toMatchObject({ code: 'BAD_WEBHOOK_URL' });
    await expect(addWebhook(ctx, projectId, 'http://hooks.example.com/x')).rejects.toMatchObject({ code: 'BAD_WEBHOOK_URL' });
    await expect(addWebhook(ctx, projectId, 'http://localhost:8787/x')).resolves.toMatchObject({ id: expect.any(Number) });
    await expect(addWebhook(ctx, projectId, 'http://127.0.0.1/x')).resolves.toMatchObject({ id: expect.any(Number) });
    await expect(addWebhook(ctx, 9999, HOOK)).rejects.toMatchObject({ code: 'NO_SUCH_PROJECT' });
  });

  it('a network error counts as a failure', async () => {
    await addWebhook(ctx, projectId, HOOK);
    await send('x');
    const failing = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    await deliverWebhooks(ctx, failing);
    const w = (await row())!;
    expect(w.attempts).toBe(1);
    expect(w.last_error).toContain('connection refused');
  });

  it('removing a webhook stops delivery and is logged', async () => {
    const { id } = await addWebhook(ctx, projectId, HOOK);
    await send('x');
    await removeWebhook(ctx, id);
    const net = fakeNet();
    await deliverWebhooks(ctx, net.fetch);
    expect(net.requests).toHaveLength(0);
    const kinds = (await changesSince(ctx, projectId, 0)).map((c) => c.kind);
    expect(kinds).toContain('webhook.added');
    expect(kinds).toContain('webhook.removed');
  });

  it('stops at maxPerRun deliveries and carries on next run', async () => {
    await addWebhook(ctx, projectId, HOOK);
    for (const b of ['a', 'b', 'c']) await send(b);
    const net = fakeNet();
    await deliverWebhooks(ctx, net.fetch, 2);
    expect(net.requests).toHaveLength(2);
    await deliverWebhooks(ctx, net.fetch, 2);
    expect(net.requests.length).toBeGreaterThanOrEqual(3);
  });
});
