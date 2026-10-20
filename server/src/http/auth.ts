import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError, ErrorCodes, forbidden, unauthorized } from '../lib/errors.js';
import type { SessionClaims } from '../modules/auth/token.js';
import { extractBearer } from '../modules/auth/token.js';
import type { UserAccount } from '../modules/user/user.types.js';
import type { AppContext } from './context.js';

/**
 * Сессия SPA. Клиент один раз проверяет initData площадки и дальше ходит с
 * `Authorization: Bearer <token>` — повторно дёргать VK ему незачем (см. auth/token.ts).
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Ставится preHandler'ом ниже. До авторизации отсутствует — отсюда `?`. */
    claims?: SessionClaims;
  }
}

export function authHook(ctx: AppContext) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const raw = extractBearer(request.headers.authorization);
    if (!raw) {
      throw unauthorized('Требуется заголовок Authorization: Bearer <token>');
    }
    // verify бросает AppError(INVALID_TOKEN, 401) — его подхватит общий error handler.
    request.claims = ctx.tokens.verify(raw);
  };
}

/** Claims текущего запроса. Вызывается только из-под authHook. */
export function claimsOf(request: FastifyRequest): SessionClaims {
  const claims = request.claims;
  if (!claims) throw unauthorized('Сессия не установлена');
  return claims;
}

/** Аккаунт запроса. 404, если игрок удалён между выпуском токена и запросом. */
export async function accountOf(
  ctx: AppContext,
  request: FastifyRequest,
  userId: string = claimsOf(request).sub
): Promise<UserAccount> {
  const account = await ctx.users.findById(userId);
  if (!account) {
    throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });
  }
  return account;
}

/**
 * Гейт dev-маршрутов: эмуляция постбэка площадки, выдача ресурсов и вход по голому
 * socialId. В production `config.devSignerEnabled` всегда false (env.ts:225 гасит флаг
 * при NODE_ENV=production), поэтому отказ здесь — не вежливость, а единственный
 * барьер между отладочным стендом и печатью денег.
 */
export function assertDevRoutes(ctx: AppContext): void {
  if (!ctx.config.devSignerEnabled) {
    throw forbidden('Отладочные маршруты выключены: DEV_SIGNER_ENABLED=true и NODE_ENV!=production');
  }
}
