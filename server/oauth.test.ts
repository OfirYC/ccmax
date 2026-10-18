import { describe, expect, it } from 'vitest';
import { authorizationState, parseOAuthCallback } from '../shared/oauth.js';
import { ProviderClient } from './providers.js';

describe('independent platform OAuth callbacks', () => {
  it('parses a full callback and code#state as the same one-use code', () => {
    const expected = { code: 'one+use/code=', state: 'platform-state' };
    expect(parseOAuthCallback('  one+use/code=#platform-state\n', 'platform-state')).toEqual(expected);
    expect(parseOAuthCallback('https://callback.example/?code=one%2Buse%2Fcode%3D&state=platform-state', 'platform-state')).toEqual(expected);
    expect(authorizationState('https://auth.example/?state=platform-state')).toBe('platform-state');
  });

  it.each([
    'one-use-code', 'one-use-code#', '#state', 'one-use-code#state#extra',
    'https://callback.example/?code=one&code=two&state=expected',
    'https://callback.example/?code=one&state=expected&state=other',
    'https://callback.example/?error=access_denied&state=expected',
    'https://callback.example/?code=one',
    'https://callback.example/?code=one&state=other',
  ])('rejects incomplete, ambiguous or wrong-platform callbacks without echoing input: %s', callback => {
    expect(() => parseOAuthCallback(callback, 'expected')).toThrow();
    try { parseOAuthCallback(callback, 'expected'); } catch (error) {
      expect((error as Error).message).not.toContain('one-use-code');
      expect((error as Error).message).not.toContain('callback.example');
    }
  });

  it.each(['gatelink', 'ai008', 'minicc'] as const)('checks %s state before any upstream call', async provider => {
    let calls = 0;
    const client = new ProviderClient(provider, { username: 'fixture', password: 'fixture' }, async () => {
      calls++; return Response.json({});
    });
    const secret = { options: { email: 'owned@example.com', proxy: 'http://proxy.example.com:8080', proxyExternalId: 'fixed-proxy' }, pendingState: 'own-platform' };
    await expect(client.exchangeOAuth(secret, 'one-use-code#other-platform')).rejects.toThrow('state 不匹配');
    await expect(client.exchangeOAuth(secret, 'one-use-code')).rejects.toThrow('完整回调');
    expect(calls).toBe(0);
  });
});
