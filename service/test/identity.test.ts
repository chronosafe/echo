import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authenticate, createAgent, reissueToken, revokeAgent, touchCheckIn } from '../src/domain/agents';
import { changeStmt, changesSince } from '../src/domain/changelog';
import {
  addMember,
  agentProjects,
  archiveProject,
  createProject,
  findRepo,
  gatedRepos,
  getOwnerSetting,
  getProject,
  normalizeRepo,
  projectMembers,
  registerRepo,
  removeMember,
  removeRepo,
  requireMember,
  setOwnerSetting,
  updateProjectSettings,
} from '../src/domain/projects';
import { addEvent, cancelEvent, recordMerge } from '../src/domain/calendar';
import { placeHold, releaseHold } from '../src/domain/holds';
import { seed, testCtx } from './helpers';

const ctx = testCtx();

describe('identity', () => {
  it('a token authenticates until revoked, then is refused', async () => {
    const { agent, token } = await createAgent(ctx, 'Carol');
    expect((await authenticate(ctx, `Bearer ${token}`)).id).toBe(agent.id);
    await revokeAgent(ctx, agent.id);
    await expect(authenticate(ctx, `Bearer ${token}`)).rejects.toMatchObject({ kind: 'rule', code: 'BAD_TOKEN', status: 401 });
  });

  it('the database never holds the raw token', async () => {
    const { token } = await createAgent(ctx, 'A');
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM agents').all()).results)).not.toContain(token);
  });

  it('seeded tokens authenticate with the same scheme', async () => {
    const s = await seed(ctx);
    expect((await authenticate(ctx, `Bearer ${s.alice.token}`)).id).toBe(s.alice.id);
    expect(s.alice.token).toMatch(/^echo_[A-Za-z0-9_-]{43}$/);
  });

  it('missing, malformed and unknown credentials are all BAD_TOKEN', async () => {
    for (const h of [null, '', 'Bearer', 'Basic abc', 'Bearer echo_nope']) {
      await expect(authenticate(ctx, h)).rejects.toMatchObject({ code: 'BAD_TOKEN', status: 401 });
    }
  });

  it('reissue invalidates the old token', async () => {
    const { agent, token } = await createAgent(ctx, 'Reissued');
    const fresh = await reissueToken(ctx, agent.id);
    expect(fresh).not.toBe(token);
    await expect(authenticate(ctx, `Bearer ${token}`)).rejects.toMatchObject({ code: 'BAD_TOKEN' });
    expect((await authenticate(ctx, `Bearer ${fresh}`)).id).toBe(agent.id);
  });

  it('check-in records the time', async () => {
    const { agent } = await createAgent(ctx, 'Checker');
    ctx.setNow('2026-11-18T22:00:00.000Z');
    await touchCheckIn(ctx, agent.id);
    expect((await authenticate(ctx, `Bearer ${(await reissueToken(ctx, agent.id))}`)).last_checked_in_at).toBe('2026-11-18T22:00:00.000Z');
  });

  it('repositories are case-insensitive and belong to one project', async () => {
    const s = await seed(ctx);
    expect((await findRepo(ctx, 'ACME/App'))?.id).toBe(s.repo.id);
    await expect(registerRepo(ctx, { kind: 'admin' }, s.other.id, 'Acme/APP')).rejects.toMatchObject({ code: 'REPO_TAKEN' });
    await expect(registerRepo(ctx, { kind: 'admin' }, s.other.id, 'Acme/APP')).rejects.toThrow(/core/);
  });

  it('repository names are normalized and malformed ones refused', async () => {
    expect(normalizeRepo('  Acme/App ')).toBe('acme/app');
    for (const bad of ['', 'noslash', 'a/b/c', '/b', 'a/', 'a b/c']) {
      expect(() => normalizeRepo(bad)).toThrow(expect.objectContaining({ kind: 'rule', code: 'BAD_REPO' }));
    }
    const s = await seed(ctx);
    const r = await registerRepo(ctx, { kind: 'admin' }, s.other.id, 'Acme/Other');
    expect(r.full_name).toBe('acme/other');
    expect(await gatedRepos(ctx)).toEqual(['acme/app', 'acme/other']);
    await removeRepo(ctx, { kind: 'admin' }, r.id);
    expect(await findRepo(ctx, 'acme/other')).toBeNull();
  });

  it('a repository with open holds or open merge events cannot be removed, and the refusal names them', async () => {
    const s = await seed(ctx);
    const admin = { kind: 'admin' } as const;
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    const ev = await addEvent(ctx, s.bobA, { projectId: s.project.id, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 710 });
    const merged = await addEvent(ctx, s.bobA, { projectId: s.project.id, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 711 });
    await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 711, mergedAt: '2026-11-18T20:01:00Z', source: 'hook' });
    const before = await changesSince(ctx, s.project.id, 0);
    const err = await removeRepo(ctx, admin, s.repo.id).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rule', code: 'REPO_HAS_OPEN_ITEMS', status: 409 });
    expect(err.message).toContain(`hold ${hold.id} on #709`);
    expect(err.message).toContain(`merge event ${ev.id} for #710`);
    expect(err.message).toContain(`merge event ${ev.id} for #710 at 2026-11-18T21:00:00Z`);
    expect(err.message).not.toContain('.000Z');
    expect(err.message).not.toContain(`merge event ${merged.id}`); // merged: not open
    expect(err.fix).toMatch(/[Rr]elease/);
    expect(err.fix).toMatch(/cancel/);
    expect(await findRepo(ctx, 'acme/app')).not.toBeNull();
    expect(await changesSince(ctx, s.project.id, 0)).toEqual(before);

    await releaseHold(ctx, s.alice.id, hold.id, 'ok');
    await expect(removeRepo(ctx, admin, s.repo.id)).rejects.toMatchObject({ code: 'REPO_HAS_OPEN_ITEMS', message: expect.not.stringContaining('hold') });
    await cancelEvent(ctx, s.bobA, ev.id);
    await removeRepo(ctx, admin, s.repo.id);
    expect(await findRepo(ctx, 'acme/app')).toBeNull();
  });

  it('requireMember refuses a non-member', async () => {
    const s = await seed(ctx);
    await requireMember(ctx, s.alice.id, s.project.id);
    await expect(requireMember(ctx, s.carol.id, s.project.id)).rejects.toMatchObject({ kind: 'rule', code: 'NOT_MEMBER', status: 403 });
  });

  it('membership changes show in members and agent projects, and archived projects drop out', async () => {
    const s = await seed(ctx);
    await addMember(ctx, { kind: 'admin' }, s.other.id, s.alice.id);
    await addMember(ctx, { kind: 'admin' }, s.other.id, s.alice.id); // idempotent
    expect((await projectMembers(ctx, s.other.id)).map((a) => a.name)).toEqual(['Alice', 'Carol']);
    expect((await agentProjects(ctx, s.alice.id)).map((p) => p.name)).toEqual(['core', 'other']);
    await archiveProject(ctx, s.other.id);
    expect((await agentProjects(ctx, s.alice.id)).map((p) => p.name)).toEqual(['core']);
    await removeMember(ctx, { kind: 'admin' }, s.project.id, s.bob.id);
    expect((await projectMembers(ctx, s.project.id)).map((a) => a.name)).toEqual(['Alice']);
    const kinds = (await changesSince(ctx, s.other.id, 0)).map((c) => c.kind);
    expect(kinds).toEqual(['member.added', 'project.updated']);
  });

  it('archiving is refused when a repository is registered between the check and the write', async () => {
    const s = await seed(ctx);
    // Stands in for a registration that lands while the archive is in flight: just before the archive's write.
    const racing = {
      ...ctx,
      db: new Proxy(ctx.db, {
        get(target, prop) {
          if (prop === 'batch') {
            return async (stmts: D1PreparedStatement[]) => {
              await target.prepare(`INSERT INTO repos (full_name, project_id) VALUES ('acme/late', ?)`).bind(s.other.id).run();
              return target.batch(stmts);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    };
    await expect(archiveProject(racing, s.other.id)).rejects.toMatchObject({ kind: 'rule', code: 'ARCHIVE_HAS_REPOS', status: 409 });
    expect((await getProject(ctx, s.other.id)).archived_at).toBeNull();
    expect(await changesSince(ctx, s.other.id, 0)).toEqual([]);
    // Without repositories it archives, and logs once.
    await removeRepo(ctx, { kind: 'admin' }, (await findRepo(ctx, 'acme/late'))!.id);
    const before = (await changesSince(ctx, s.other.id, 0)).length;
    await archiveProject(ctx, s.other.id);
    expect((await getProject(ctx, s.other.id)).archived_at).toBe(ctx.now());
    expect((await changesSince(ctx, s.other.id, 0)).slice(before).map((c) => c.kind)).toEqual(['project.updated']);
  });

  it('change log sequence increases and changesSince filters by project', async () => {
    const s = await seed(ctx);
    const emit = (projectId: number, kind: 'todo.added' | 'todo.edited', data?: unknown) =>
      changeStmt(ctx, { projectId, actor: s.aliceA, kind, subjectId: 7, data }).run();
    await emit(s.project.id, 'todo.added', { title: 'x' });
    await emit(s.other.id, 'todo.added');
    await emit(s.project.id, 'todo.edited');
    const core = await changesSince(ctx, s.project.id, 0);
    expect(core.map((c) => c.kind)).toEqual(['todo.added', 'todo.edited']);
    expect(core[1].seq).toBeGreaterThan(core[0].seq);
    expect(core[0]).toMatchObject({ actor: 'Alice', subjectId: 7, data: { title: 'x' } });
    expect(core[1].data).toBeNull();
    expect((await changesSince(ctx, s.other.id, 0)).map((c) => c.kind)).toEqual(['todo.added']);
    expect((await changesSince(ctx, s.project.id, core[0].seq)).map((c) => c.seq)).toEqual([core[1].seq]);
    expect(await changesSince(ctx, s.project.id, 0, 1)).toHaveLength(1);
  });

  it('approval window outside 5..240 is refused', async () => {
    const s = await seed(ctx);
    for (const w of [4, 241, 0, -5, 30.5]) {
      await expect(updateProjectSettings(ctx, s.project.id, { approvalWindowMin: w })).rejects.toMatchObject({ kind: 'rule', code: 'BAD_WINDOW' });
    }
    await updateProjectSettings(ctx, s.project.id, { approvalWindowMin: 5 });
    await updateProjectSettings(ctx, s.project.id, { approvalWindowMin: 240, approvalsRequired: true });
    expect(await getProject(ctx, s.project.id)).toMatchObject({ approval_window_min: 240, approvals_required: 1 });
  });

  it('projects reject duplicate names and owner settings round-trip', async () => {
    await createProject(ctx, 'solo');
    await expect(createProject(ctx, 'solo')).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    expect(await getOwnerSetting(ctx, 'k')).toBeNull();
    await setOwnerSetting(ctx, 'k', 'v1');
    await setOwnerSetting(ctx, 'k', 'v2');
    expect(await getOwnerSetting(ctx, 'k')).toBe('v2');
  });
});
