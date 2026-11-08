// HTTP 基础工具：固定来源校验、有界 JSON 读取、稳定的错误对象与响应头。
// 应用身份只来自本应用自己的会话校验；绝不使用 ctx.user 或任何平台身份回退。

// 站点固定公开来源（非密钥的站点常量）。校验时不读取请求的 Host / Forwarded 头。
export const PUBLIC_ORIGIN = ''; // Set a fixed HTTPS origin before deployment.

export const BODY_LIMIT_BYTES = 8192;

export class AppError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

const NO_STORE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };

export function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { ...NO_STORE, ...extra } });
}

export function errorJson(code, status, extra = {}) {
  return json({ error: code }, status, extra);
}

// 网关会把 app 段替换成部署的物理函数名，Provider 也可能先剥掉 /functions/v1。
export function applicationPath(request) {
  const match = new URL(request.url).pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
  if (!match) throw new AppError('not_found', 404);
  return match[1] || '/';
}

// 不安全方法必须来自固定来源（SameSite=Lax Cookie 之外的第二道 CSRF 防线）。
export function requireTrustedOrigin(request, origin = PUBLIC_ORIGIN) {
  let configured;
  try { configured = new URL(origin); } catch { throw new AppError('application_auth_not_configured', 503); }
  if (configured.protocol !== 'https:' || configured.origin !== origin) throw new AppError('application_auth_not_configured', 503);
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.get('origin') !== origin) throw new AppError('origin_forbidden', 403);
}

// 按实际流读取的字节数设上限，不信任 Content-Length。
export async function readJson(request, maxBytes = BODY_LIMIT_BYTES) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new AppError('invalid_input', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('invalid_input', 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError('payload_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('invalid_input', 400);
  }
}

// 把数据层结果转换成业务结果：错误保留为稳定的应用错误码，不泄露 Provider 细节。
export function rows(result) {
  if (result?.error || !Array.isArray(result?.data)) throw new AppError('database_unavailable', 503);
  return result.data;
}
