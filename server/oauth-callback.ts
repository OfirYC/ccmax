import { AppError, assert } from './core.js';
import { parseOAuthCallback } from '../shared/oauth.js';

export function validateOAuthCallback(value: string, expectedState: unknown) {
  assert(typeof expectedState === 'string' && expectedState.length > 0,
    '此授权缺少可核验的 state，请重新生成授权链接', 409);
  try { return parseOAuthCallback(value, expectedState); }
  catch (error) { throw new AppError(400, (error as Error).message); }
}

export function statefulOAuthCallback(value: string, expectedState: unknown): string {
  const { code, state } = validateOAuthCallback(value, expectedState);
  return `${code}#${state}`;
}
