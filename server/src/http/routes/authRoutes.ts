import type { FastifyInstance } from 'fastify';

import { AppError, ErrorCodes, forbidden } from '../../lib/errors.js';
import { verifyVkInitData, type SocialIdentity } from '../../modules/auth/vk.adapter.js';
import { createAccount, type UserAccount } from '../../modules/user/user.types.js';
import { authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { bodyOf, optionalStringOf, stringOf, viewOf } from '../helpers.js';

/**
 * Вход в игру и «кто я».
 *
 * Два пути авторизации сосуществуют намеренно:
 *  - `/v1/auth/vk/init-data` — боевой: проверяет подпись WebView ВКонтакте;
 *  - `/v1/auth/dev-login`    — отладочный: принимает голый socialId. Без него стенд
 *    невозможно открыть, не имея App ID и Secret Key, а их нет ни у кого до релиза.
 *
 * Dev-путь закрыт тем же флагом, что и генератор initData (DEV_SIGNER_ENABLED), и
 * гасится в production на уровне загрузки конфига — см. env.ts:225.
 */

type Identity = Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>;

interface LoginOutcome {
  account: UserAccount;
  created: boolean;
}

async function login(ctx: AppContext, identity: Identity, now: Date): Promise<LoginOutcome> {
  const found = await ctx.users.findBySocial(identity.platform, identity.socialId);
  if (found) {
    // Вход обновляет lastLoginAt: по нему строятся «вернулся за N дней» и антифрод.
    const account = await ctx.users.transact(found.id, (current) => ({ ...current, lastLoginAt: now }));
    return { account, created: false };
  }
  const { account } = await ctx.users.getOrCreate(identity, now, (id, at) =>
    createAccount(id, at, ctx.config.economy, ctx.idFactory)
  );
  return { account, created: true };
}

function sessionOf(ctx: AppContext, account: UserAccount, now: Date, created: boolean) {
  const session = ctx.tokens.issue({ sub: account.id, platform: account.platform, sid: account.socialId }, now);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    created,
    ...viewOf(ctx.config, account, now)
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/auth/vk/init-data', async (request) => {
    const body = bodyOf(request);
    const initData = stringOf(body, 'initData', 8192);
    const now = ctx.now();
    const { identity } = verifyVkInitData(initData, ctx.config.vk, now);
    const { account, created } = await login(ctx, identity, now);
    ctx.logger.info('auth_vk', { userId: account.id, created, scheme: identity.platform });
    return sessionOf(ctx, account, now, created);
  });

  app.post('/v1/auth/dev-login', async (request) => {
    if (!ctx.config.devSignerEnabled) {
      throw forbidden('DEV_SIGNER_ENABLED выключен: вход по голому socialId разрешён только вне production');
    }
    const body = bodyOf(request);
    const socialId = optionalStringOf(body, 'socialId', 64) ?? '1';
    const now = ctx.now();
    const identity: Identity = {
      platform: 'vk',
      socialId,
      appId: ctx.config.vk.appId > 0 ? String(ctx.config.vk.appId) : null,
      groupId: null
    };
    const { account, created } = await login(ctx, identity, now);
    ctx.logger.info('auth_dev_login', { userId: account.id, socialId, created });
    return sessionOf(ctx, account, now, created);
  });

  app.get('/v1/me', { preHandler: authHook(ctx) }, async (request) => {
    const claims = claimsOf(request);
    const account = await ctx.users.findById(claims.sub);
    if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId: claims.sub });
    return { session: claims, ...viewOf(ctx.config, account, ctx.now()) };
  });
}
