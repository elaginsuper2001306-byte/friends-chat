import { createSiteContext, createDatabaseClient, errorResponse } from './_qoder/backend.mjs';
import { createApplication } from './router.mjs';

// forwardApplicationCredentials 保留应用自己的 Cookie / Authorization：
// 本应用的注册、登录与会话完全自持，不使用平台身份，也没有任何身份回退。
const handle = createApplication({ db: createDatabaseClient(), origin: () => Deno.env.get('APP_ORIGIN') });

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request, { forwardApplicationCredentials: true });
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
