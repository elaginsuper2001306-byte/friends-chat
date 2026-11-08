// 按用户名持久化的登录/注册限流器。
// 计数保存在数据库里（跨实例、跨重启），并且用「带谓词的更新」做真正的 CAS：
// 读取到的 window_started_at / attempt_count 会作为同一次写入的谓词，谓词不匹配即代表
// 本次写入没有生效（返回空结果），此时才允许有界重试。写入结果未知时绝不重试、绝不重放，
// 直接按失败关闭处理。
import { AppError, rows } from './http.mjs';

export const LIMITS = {
  login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
  register: { maxAttempts: 5, windowMs: 60 * 60 * 1000 },
  message: { maxAttempts: 30, windowMs: 60 * 1000 },
};

// 只在「确认未生效」时重试（谓词不匹配 = 本次写入没有生效）。
// 上限按「单次突发可达 2×窗口上限」估算：预算内会得到明确的 429；
// 极端争用下超出预算则按失败关闭返回 limiter_busy，绝不放行。
const MAX_CAS_ATTEMPTS = 24;

const bucketKey = (scope, username) => `${scope}:${username}`;
const iso = (ms) => new Date(ms).toISOString();

async function readBucket(db, key) {
  return rows(await db.from('auth_limiter')
    .select('key,window_started_at,attempt_count').eq('key', key).limit(1));
}

// 尝试消费一次配额。allowed=false 时附带 retryAfterMs。
export async function consume(db, scope, username, now = Date.now()) {
  const limit = LIMITS[scope];
  if (!limit) throw new AppError('limiter_unavailable', 503);
  const key = bucketKey(scope, username);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const found = await readBucket(db, key);

    if (found.length === 0) {
      // 首次出现该键：唯一主键上的「插入或忽略」是原子判定，并发时只有一个写入者成功。
      const inserted = rows(await db.from('auth_limiter').insertIfAbsent({
        key, window_started_at: iso(now), attempt_count: 1,
      }, { onConflict: 'key' }).select('key'));
      if (inserted.length === 1) return { allowed: true, remaining: limit.maxAttempts - 1 };
      continue;
    }

    const row = found[0];
    const startedAt = Date.parse(row.window_started_at);
    const count = row.attempt_count;
    if (typeof row.window_started_at !== 'string' || !Number.isSafeInteger(count) || count < 0) {
      throw new AppError('limiter_unavailable', 503);
    }

    if (!Number.isFinite(startedAt) || now - startedAt >= limit.windowMs) {
      // 窗口过期：以观察到的窗口起点为谓词重置，避免与并发写入互相覆盖。
      const reset = rows(await db.from('auth_limiter')
        .update({ window_started_at: iso(now), attempt_count: 1 })
        .eq('key', key).eq('window_started_at', row.window_started_at).select('key'));
      if (reset.length === 1) return { allowed: true, remaining: limit.maxAttempts - 1 };
      continue;
    }

    if (count >= limit.maxAttempts) {
      return { allowed: false, retryAfterMs: Math.max(0, startedAt + limit.windowMs - now) };
    }

    // 递增同样以观察到的 (窗口起点, 计数) 为谓词：谓词不匹配说明计数已被别人推进，
    // 本次没有写入，重新读取后再判断。
    const incremented = rows(await db.from('auth_limiter')
      .update({ attempt_count: count + 1 })
      .eq('key', key).eq('window_started_at', row.window_started_at).eq('attempt_count', count)
      .select('key'));
    if (incremented.length === 1) return { allowed: true, remaining: limit.maxAttempts - (count + 1) };
  }

  // 有界重试仍未取得一致结果：按失败关闭处理，不放行。
  throw new AppError('limiter_busy', 503);
}

// 说明：刻意不提供「登录成功后清零计数」。
// 那种做法只能以 (键, 窗口起点) 为谓词，无法识别同窗口内的并发递增，会把别人刚消费的
// 配额覆盖掉；而且它允许用成功登录换取无限次尝试。固定窗口累计计数更简单，也更严格。
