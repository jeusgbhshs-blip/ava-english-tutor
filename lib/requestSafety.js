/** Bind stored credentials to their configured service origin, including scheme and port. */
function endpointOrigin(value, protocols) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('服务地址格式不正确，请填写完整的接口地址。');
  }
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error(`服务地址必须使用 ${protocols.map((p) => p.slice(0, -1)).join('/')}，且不能包含用户名或密码。`);
  }
  return url.origin;
}

/**
 * Changing an origin requires explicitly supplied replacement credentials or a clear.
 * All unprovided alternatives are cleared on a change, so an old access token cannot
 * become active later. A path change within the same origin preserves saved keys.
 */
export function credentialsForEndpoint({
  previousUrl,
  nextUrl,
  previousCredentials,
  providedCredentials = {},
  clear = false,
  protocols = ['http:', 'https:'],
  errorMessage = '更换接口源站时，请重新填写该地址的密钥，或明确清空已保存的密钥。',
}) {
  const nextOrigin = endpointOrigin(nextUrl, protocols);
  let previousOrigin = null;
  try { previousOrigin = endpointOrigin(previousUrl, protocols); } catch { /* allow repairing an old invalid URL with new credentials */ }
  const keys = Object.keys(previousCredentials);
  const provided = Object.fromEntries(keys.map((key) => [key,
    typeof providedCredentials[key] === 'string' ? providedCredentials[key].trim() : '',
  ]));
  if (clear === true) return Object.fromEntries(keys.map((key) => [key, '']));
  if (previousOrigin !== nextOrigin) {
    if (keys.some((key) => previousCredentials[key]) && !keys.some((key) => provided[key])) {
      throw new Error(errorMessage);
    }
    return provided;
  }
  return Object.fromEntries(keys.map((key) => [key, provided[key] || previousCredentials[key] || '']));
}
