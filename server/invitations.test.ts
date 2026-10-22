import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { migrate, type DB } from './db.js';
import { bootstrap, today, verifyPassword } from './core.js';
import { openTestDB } from './test-db.js';

describe('priced team invitations', () => {
  let db: DB, app: FastifyInstance, ownerCookie: string;
  const password = 'invitation-test-password', headers = { 'x-ccmax-request': '1' };
  const registration = (email: string) => ({ name: 'Invited member', email, password });
  const tokenOf = (invitation: any) => new URL(invitation.url).pathname.split('/').at(-1)!;
  const request = (method: any, url: string, payload?: any, cookie?: string) => app.inject({ method, url, headers: { ...headers, ...(cookie ? { cookie } : {}) }, payload });
  async function login(email: string) {
    const response = await request('POST', '/api/auth/login', { email, password });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0];
  }
  async function invite(cookie = ownerCookie, extra = {}) {
    const response = await request('POST', '/api/team/invitations', { name: 'Private campaign', rates: { ai008: 0.1234, minicc: 0 }, ...extra }, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().invitation;
  }
  async function agent(name: string) {
    const response = await request('POST', '/api/team', { name, email: `${name}@example.com`, password, rates: { ai008: 0.3 } }, ownerCookie);
    expect(response.statusCode).toBe(200);
    return { user: response.json().user, cookie: await login(`${name}@example.com`) };
  }

  beforeEach(async () => {
    db = await openTestDB(); await migrate(db);
    await bootstrap(db, { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: password });
    ({ app } = await createApp(db, { encryptionKey: 'ab'.repeat(32), appUrl: 'http://localhost:3000' }));
    ownerCookie = await login('owner@example.com');
  });
  afterEach(async () => { await app.close(); await db.close(); });

  it('registers under the inviter with each link’s fixed rates, including zero, and never exposes private fields', async () => {
    const parent = await agent('parent'), first = await invite(parent.cookie), second = await invite(parent.cookie, { rates: { ai008: 0.2 } });
    const token = tokenOf(first), preview = await request('GET', `/api/invitations/${token}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ inviterName: 'parent', rates: { B: '0.1234', C: '0.0000' } });
    expect(preview.body).not.toContain('Private campaign');
    expect(preview.body).not.toContain('parent@example.com');
    expect(preview.body).not.toContain('token_secret');
    expect((await request('POST', `/api/invitations/${token}/register`, registration('New@EXAMPLE.com'))).statusCode).toBe(200);
    expect((await request('POST', `/api/invitations/${tokenOf(second)}/register`, registration('other@example.com'))).statusCode).toBe(200);
    const [member] = await db.query("SELECT * FROM users WHERE email='new@example.com'");
    expect(member).toMatchObject({ parent_id: parent.user.id, role: 'agent', active: true });
    expect(await verifyPassword(password, member.password_hash)).toBe(true);
    const quotes = await db.query('SELECT provider,rate,effective_date,created_by FROM rates WHERE user_id=$1 ORDER BY provider', [member.id]);
    expect(quotes).toEqual([{ provider: 'ai008', rate: '0.1234', effective_date: today(), created_by: parent.user.id }, { provider: 'minicc', rate: '0.0000', effective_date: today(), created_by: parent.user.id }]);
    expect((await db.query("SELECT rate FROM rates r JOIN users u ON u.id=r.user_id WHERE u.email='other@example.com'"))[0].rate).toBe('0.2000');
    await request('PUT', `/api/team/${member.id}/rates`, { provider: 'ai008', rate: 0.1 }, parent.cookie);
    expect((await request('GET', `/api/invitations/${token}`)).json().rates.B).toBe('0.1234');
    expect((await request('GET', '/api/team/invitations', undefined, parent.cookie)).json().invitations.find((i: any) => i.id === first.id)).toMatchObject({ used_count: 1, url: first.url });
    expect((await db.query('SELECT * FROM invitation_redemptions WHERE user_id=$1', [member.id]))).toHaveLength(1);
    expect((await db.query("SELECT * FROM audits WHERE action='invitation.accept' AND actor_id=$1", [member.id]))).toHaveLength(1);
    await login('new@example.com');
  });

  it('allows only one concurrent registration for a single-use link', async () => {
    const invitation = await invite(ownerCookie, { maxUses: 1 }), url = `/api/invitations/${tokenOf(invitation)}/register`;
    const responses = await Promise.all([request('POST', url, registration('one@example.com')), request('POST', url, registration('two@example.com'))]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 410]);
    expect((await db.query('SELECT used_count FROM invitations WHERE id=$1', [invitation.id]))[0].used_count).toBe(1);
    expect(await db.query('SELECT * FROM invitation_redemptions WHERE invitation_id=$1', [invitation.id])).toHaveLength(1);
    expect((await request('GET', `/api/invitations/${tokenOf(invitation)}`)).statusCode).toBe(410);
  });

  it('rolls back failed or duplicate registrations without consuming a place or changing an existing account', async () => {
    const invitation = await invite(ownerCookie, { maxUses: 1 }), url = `/api/invitations/${tokenOf(invitation)}/register`;
    for (const extra of [{ parent_id: 'different-parent' }, { role: 'owner' }, { rates: { ai008: 1 } }]) {
      expect((await request('POST', url, { ...registration('new@example.com'), ...extra })).statusCode).toBe(400);
    }
    expect((await request('POST', url, { ...registration('new@example.com'), password: 'short' })).statusCode).toBe(400);
    expect((await request('POST', url, registration('owner@example.com'))).statusCode).toBe(409);
    expect((await db.query('SELECT used_count FROM invitations WHERE id=$1', [invitation.id]))[0].used_count).toBe(0);
    expect(await db.query('SELECT * FROM invitation_redemptions')).toEqual([]);
    expect((await request('POST', url, registration('new@example.com'))).statusCode).toBe(200);
  });

  it('isolates link management to its creator and revokes new access while keeping registered contracts', async () => {
    const a = await agent('a'), b = await agent('b'), invitation = await invite(a.cookie), token = tokenOf(invitation);
    expect((await request('POST', `/api/invitations/${token}/register`, registration('kept@example.com'))).statusCode).toBe(200);
    for (const cookie of [b.cookie, ownerCookie]) {
      expect((await request('GET', '/api/team/invitations', undefined, cookie)).json().invitations).toEqual([]);
      expect((await request('DELETE', `/api/team/invitations/${invitation.id}`, undefined, cookie)).statusCode).toBe(404);
    }
    const [stored] = await db.query('SELECT token_hash,token_secret FROM invitations WHERE id=$1', [invitation.id]);
    expect(stored.token_hash).not.toBe(token); expect(stored.token_secret).not.toContain(token);
    expect((await request('DELETE', `/api/team/invitations/${invitation.id}`, undefined, a.cookie)).statusCode).toBe(200);
    expect((await request('DELETE', `/api/team/invitations/${invitation.id}`, undefined, a.cookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/invitations/${token}`)).statusCode).toBe(410);
    expect((await request('POST', `/api/invitations/${token}/register`, registration('blocked@example.com'))).statusCode).toBe(410);
    expect((await db.query("SELECT parent_id FROM users WHERE email='kept@example.com'"))[0].parent_id).toBe(a.user.id);
    expect((await db.query("SELECT rate FROM rates r JOIN users u ON u.id=r.user_id WHERE u.email='kept@example.com' AND provider='ai008'"))[0].rate).toBe('0.1234');
  });

  it('rejects expired, malformed, missing and disabled-team invitations', async () => {
    const parent = await agent('parent'), invitation = await invite(parent.cookie), token = tokenOf(invitation);
    await db.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [invitation.id]);
    for (const value of [token, 'missing', 'x'.repeat(43)]) {
      expect((await request('GET', `/api/invitations/${value}`)).statusCode).toBe(410);
      expect((await request('POST', `/api/invitations/${value}/register`, registration('blocked@example.com'))).statusCode).toBe(410);
    }
    await db.query('UPDATE invitations SET expires_at=NULL WHERE id=$1', [invitation.id]);
    await db.query("UPDATE users SET active=false WHERE role='owner'");
    expect((await request('GET', `/api/invitations/${token}`)).statusCode).toBe(410);
    expect((await request('POST', `/api/invitations/${token}/register`, registration('blocked@example.com'))).statusCode).toBe(410);
    expect((await db.query('SELECT used_count FROM invitations WHERE id=$1', [invitation.id]))[0].used_count).toBe(0);
  });

  it('keeps CSRF, authentication and strict price validation on the new endpoints', async () => {
    const invitation = await invite(), url = `/api/invitations/${tokenOf(invitation)}/register`;
    expect((await app.inject({ method: 'POST', url, payload: registration('blocked@example.com') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://other.example' }, payload: registration('blocked@example.com') })).statusCode).toBe(403);
    expect((await request('GET', '/api/team/invitations')).statusCode).toBe(401);
    expect((await request('POST', '/api/team/invitations', { name: 'anonymous', rates: { ai008: 0.1 } })).statusCode).toBe(401);
    expect((await request('DELETE', `/api/invitations/${tokenOf(invitation)}`)).statusCode).toBe(401);
    for (const rates of [{}, { ai008: -0.1 }, { ai008: 1.1 }, { ai008: 0.12345 }, { other: 0.1 }]) {
      expect((await request('POST', '/api/team/invitations', { name: 'Bad price', rates }, ownerCookie)).statusCode).toBe(400);
    }
  });
});
