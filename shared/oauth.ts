// Keep callback parsing identical in the browser, API and upstream adapters.
// Never include the submitted URL, code or state in validation errors.
export function authorizationState(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.searchParams.getAll('state').length !== 1) return;
    return url.searchParams.get('state') || undefined;
  } catch { return; }
}

export function parseOAuthCallback(value: string, expectedState?: string) {
  const input = value.trim();
  let code = '', state = '';
  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('请输入有效的完整回调地址或 code#state'); }
    if (url.searchParams.has('error')) throw new Error('授权未完成，请重新打开此平台的授权链接');
    if (url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1) {
      throw new Error('请粘贴完整回调地址或 code#state，必须保留 state');
    }
    code = url.searchParams.get('code') || '';
    state = url.searchParams.get('state') || '';
  } else {
    const parts = input.split('#');
    if (parts.length !== 2) throw new Error('请粘贴完整回调地址或 code#state，必须保留 state');
    [code, state] = parts;
  }
  if (!code || !state || /[\s#]/.test(code) || /[\s#]/.test(state)) {
    throw new Error('请输入有效的完整回调地址或 code#state');
  }
  if (expectedState !== undefined && state !== expectedState) {
    throw new Error('OAuth state 不匹配：请使用此平台当前授权链接生成的回调，不能跨平台复用');
  }
  return { code, state };
}
