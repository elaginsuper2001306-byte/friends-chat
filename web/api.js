// Same-origin Function request helper. Never renders arbitrary server/gateway text.
export class ApiError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function requestJson(url, init = {}, messages = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  let response;
  try {
    response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError('Не удалось связаться с сервером. Проверьте интернет и повторите.', 'network_error');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(response.status === 401 ? 'Сначала войдите в аккаунт.' : 'У вас нет прав на это действие.', 'access_denied', response.status);
  }
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('Сервис вернул неожиданный ответ. Попробуйте ещё раз.', 'invalid_response', response.status);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response', response.status); }
  const body = data && typeof data === 'object' ? data : null;
  const code = typeof body?.error === 'string' ? body.error
    : (!response.ok || body?.ok === false) && typeof body?.code === 'string' ? body.code
    : response.ok ? null : 'request_failed';
  if (!response.ok || body?.ok === false || code) {
    const resolved = code ?? 'request_failed';
    const message = Object.prototype.hasOwnProperty.call(messages, resolved)
      ? messages[resolved]
      : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
    throw new ApiError(message, resolved, response.status);
  }
  return data;
}

// A lost response does not prove whether a write committed; never auto-replay here.
export function isWriteOutcomeUnknown(error) {
  if (!(error instanceof ApiError) || error.status === 401 || error.status === 403) return false;
  if (error.code === 'write_rejected' || error.code === 'application_auth_not_configured') return false;
  return ['network_error', 'invalid_response', 'write_result_unknown'].includes(error.code)
    || (error.status >= 500 && error.status < 600);
}