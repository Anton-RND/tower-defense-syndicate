import type { FastifyInstance } from 'fastify';

import { MINING_RESOURCES } from '../../config/env.js';
import { CRAFT_TECH_IDS, type CraftTechId } from '../../config/materials.js';
import { JUNK_IDS, METAL_IDS, type JunkId, type MetalId } from '../../config/workshop.js';
import { validationError } from '../../lib/errors.js';
import {
  SIGN_KEYS,
  VkSignatureScheme,
  signVkParams,
  type VkParams
} from '../../modules/auth/vk.signature.js';
import {
  asterium,
  credit,
  junk as junkTarget,
  metal as metalTarget,
  resource as resourceTarget,
  tech as techTarget,
  type BalanceTarget
} from '../../modules/economy/wallet.js';
import { chargeStanium } from '../../modules/materials/commit.js';
import { confirmPayment, refundPayment } from '../../modules/payment/commit.js';
import { createAccount } from '../../modules/user/user.types.js';
import { accountOf, assertDevRoutes, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, intOf, optionalIntOf, optionalStringOf, stringOf, viewOf } from '../helpers.js';

const SCHEMES = [VkSignatureScheme.MINI_APP, VkSignatureScheme.LAUNCH_PARAMS] as const;

/**
 * Отладочные маршруты стенда. ВСЕ закрыты `assertDevRoutes`: в production
 * `config.devSignerEnabled` всегда false (env.ts:225), поэтому сюда физически
 * невозможно попасть с деньгами игрока.
 *
 * Зачем здесь три разные вещи:
 *  - `/payments/confirm|refund` — эмуляция подписанного события площадки. Настоящий
 *    вебхук требует VK_SECRET_KEY и приходит вне сессии игрока; стенд подменяет его,
 *    иначе весь маршрут «купил пак → материал пришёл → возврат → долг» непроверяем.
 *  - `/grant` — печать баланса. Без неё невозможно посмотреть станиумное поле и долг
 *    по рефанду, не наиграв несколько часов майнинга.
 *  - `/seed-opponents` — соперники. В пустой базе findOpponent всегда возвращает
 *    NO_OPPONENT, и PvP-часть стенда была бы мертва.
 */
export function registerDevRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  const deps = { users: ctx.users, ledger: ctx.ledger, idFactory: ctx.idFactory };

  /**
   * Генератор подписанной initData: `POST /v1/dev/vk/sign`.
   *
   * ЗАЧЕМ. Боевой вход (`/v1/auth/vk/init-data`) непроверяем без координат
   * площадки: локальный стенд не имеет ни App ID, ни Secret Key, и вся цепочка
   * «подписал WebView → проверил сервер → родился аккаунт → привязался реферал»
   * осталась бы неописанной ни одним тестом и ни одной кнопкой. Секрет known —
   * значит initData можно собрать самому, тем же кодом, которым её проверяют
   * (`signVkParams` из vk.signature.ts), а не второй формулой, которая разойдётся
   * с первой в самый неудобный момент.
   *
   * КООРДИНАТЫ. По умолчанию берутся из окружения (`VK_APP_ID`/`VK_SECRET_KEY`),
   * поэтому сценарий «поднял стенд с тестовыми ключами → сгенерировал строку →
   * вошёл через боевой маршрут» работает без тела запроса. `appId`/`secretKey`
   * можно передать явно — так проверяются негативные векторы (чужой секрет,
   * чужой app_id, устаревший `ts` через `ageSec`).
   *
   * БЕЗОПАСНОСТЬ. Маршрут закрыт `assertDevRoutes` и гасится в production на
   * уровне конфига (env.ts:225): снаружи он не печатает ничего. Бюджет
   * `guard('auth')` на нём свой, а не игровой: запросы к нему идут до того, как
   * у клиента появится токен, и лимитер обязан считать их в том же ведре, что и
   * остальные попытки входа.
   */
  app.post('/v1/dev/vk/sign', { preHandler: ctx.security.guard('auth') }, async (request) => {
    assertDevRoutes(ctx);
    const body = bodyOf(request);

    const schemeRaw = optionalStringOf(body, 'scheme', 32) ?? VkSignatureScheme.MINI_APP;
    if (!(SCHEMES as readonly string[]).includes(schemeRaw)) {
      throw validationError(`Поле «scheme» должно быть одним из: ${SCHEMES.join(', ')}`, {
        field: 'scheme',
        allowed: SCHEMES
      });
    }
    const scheme = schemeRaw as VkSignatureScheme;

    const signKeyRaw = optionalStringOf(body, 'signKey', 8) ?? 'sign';
    if (!(SIGN_KEYS as readonly string[]).includes(signKeyRaw)) {
      throw validationError(`Поле «signKey» должно быть одним из: ${SIGN_KEYS.join(', ')}`, {
        field: 'signKey',
        allowed: SIGN_KEYS
      });
    }
    // `hash` по документации площадкой не подписывается, но часть переходов из
    // шеринга приходит так, будто он обычный параметр, и верификатор перебирает
    // обе формы (VkHashPolicy). Генератор обязан уметь выдать вторую: иначе эта
    // ветка непроверяема ни тестом, ни смоком, ни doctor'ом.
    const signHash = body['signHash'] === true;

    const appId = optionalIntOf(body, 'appId', { min: 1 }) ?? ctx.config.vk.appId;
    if (appId <= 0) {
      throw validationError('Не задан App ID: передайте appId в теле или VK_APP_ID в окружении', { field: 'appId' });
    }
    const secretKey = optionalStringOf(body, 'secretKey', 256) ?? ctx.config.vk.secretKey;
    if (secretKey.length === 0) {
      throw validationError('Не задан секрет: передайте secretKey в теле или VK_SECRET_KEY в окружении', {
        field: 'secretKey'
      });
    }

    const socialId = optionalStringOf(body, 'socialId', 32) ?? '1';
    if (!/^\d+$/.test(socialId) || socialId === '0') {
      throw validationError('Поле «socialId» обязано быть числовым id пользователя ВКонтакте', { field: 'socialId' });
    }
    const groupId = optionalStringOf(body, 'groupId', 32);
    const ref = optionalStringOf(body, 'ref', 128);
    // Возраст подписи, сек: 0 — свежая. Нужен для негативных векторов (устаревшая
    // initData обязана давать EXPIRED_INIT_DATA, а не 401 «подпись не совпала»).
    const ageSec = optionalIntOf(body, 'ageSec', { min: 0, max: 604_800 }) ?? 0;
    const now = ctx.now();
    const ts = String(Math.floor(now.getTime() / 1000) - ageSec);
    const sessionHash = optionalStringOf(body, 'sessionHash', 128) ?? `dev-${ts}`;

    const params: VkParams =
      scheme === VkSignatureScheme.LAUNCH_PARAMS
        ? {
            vk_anonymous_id: '0',
            vk_app_id: String(appId),
            vk_group_id: groupId ?? '0',
            vk_is_app_user: '1',
            vk_is_secure: '1',
            vk_language: 'ru',
            vk_loader_body_size: '0',
            vk_protocol: 'https',
            vk_ts: ts,
            vk_user_id: socialId
          }
        : {
            allow_preview: '0',
            is_app_user: '1',
            language: 'ru',
            listener: '0',
            platform: 'vk',
            platform_type: 'mobile_web',
            realm: 'vk.com',
            session_hash: sessionHash,
            sign_version: '2',
            ts,
            vk_app_id: String(appId),
            viewer_id: socialId
          };
    if (groupId !== null && scheme === VkSignatureScheme.MINI_APP) params['group_id'] = groupId;
    // Реферальная метка уходит ДВОЙНО: подписанным полем (`ref` / `vk_ref`) и
    // неподписанным `hash` — ровно так, как её приносит живой WebView. Одна
    // генерация покрывает обе ветки extractReferralClaim.
    if (ref !== null) {
      params[scheme === VkSignatureScheme.LAUNCH_PARAMS ? 'vk_ref' : 'ref'] = ref;
      params['hash'] = ref;
    }

    const signed = signVkParams(params, {
      appId,
      secretKey,
      scheme,
      signKey: signKeyRaw as (typeof SIGN_KEYS)[number],
      includeHash: signHash
    });
    const ttlSec = ctx.config.vk.initDataSourceTtlSec;
    ctx.logger.info('dev_vk_sign', {
      appId,
      socialId,
      scheme,
      signKey: signed.signKey,
      signHash,
      ageSec,
      hasRef: ref !== null
    });
    return {
      initData: signed.initData,
      sign: signed.sign,
      scheme: signed.scheme,
      signKey: signed.signKey,
      signHash,
      appId,
      socialId,
      ts,
      checkString: signed.checkString,
      // Сколько секунд строка проживёт на боевом входе; отрицательно — уже мертва.
      expiresInSec: ttlSec - ageSec
    };
  });

  app.post('/v1/dev/grant', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const grants = collectGrants(bodyOf(request));
    if (grants.length === 0) {
      throw validationError('Не указано ни одного поля для выдачи', { allowed: ALLOWED_GRANT_FIELDS });
    }
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      let next = synced;
      const drafts = [];
      for (const grant of grants) {
        const movement = credit(next, grant.target, grant.amount, {
          ts: now,
          reason: 'admin',
          refType: null,
          refId: 'dev_grant',
          idempotencyKey: null,
          meta: { source: 'dev_grant' }
        });
        next = movement.account;
        drafts.push(movement.draft);
      }
      return { account: next, drafts, meta: { count: drafts.length } };
    });
    ctx.logger.info('dev_grant', { userId: account.id, movements: meta.count });
    return { ...viewOf(ctx.config, account, now), result: { movements: meta.count } };
  });

  /**
   * Состояние очереди уведомлений (Часть 2, backlog 3).
   *
   * Единственная наблюдаемая точка пути «продажа → пуш». Сам факт рождается внутри
   * денежного протокола, а доставка уходит в фон, поэтому ни того, ни другого нельзя
   * увидеть ни в одном ответе игрока: продажа проходит молча, и молча потерянный пуш
   * выглядит точно так же, как доставленный. Без этого маршрута проводку можно
   * проверить только подняв подставной VK API, то есть силами оператора, а не смоука.
   */
  app.get('/v1/dev/notices', auth, async () => {
    assertDevRoutes(ctx);
    return {
      result: {
        readiness: ctx.notices.readiness(),
        stats: ctx.notices.stats(),
        queued: ctx.notices.size()
      }
    };
  });

  app.post('/v1/dev/seed-opponents', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const body = bodyOf(request);
    const count = intOf(body, 'count', { min: 1, max: 50 });
    const stanium = intOf(body, 'stanium', { min: 0, max: 96 });
    const batch = optionalStringOf(body, 'batch', 32) ?? String(now.getTime());

    const seeded: Array<{ userId: string; socialId: string; rating: number; staniumField: string | null }> = [];
    for (let index = 0; index < count; index += 1) {
      const socialId = `bot-${batch}-${index + 1}`;
      const { account } = await ctx.users.getOrCreate(
        { platform: 'vk', socialId, appId: null, groupId: null },
        now,
        (identity, at) => createAccount(identity, at, ctx.config.economy, ctx.idFactory)
      );
      let field: Date | null = null;
      if (stanium > 0) {
        // Поле ставим через боевой хаб, а не правкой документа: иначе стенд проверял
        // бы не тот код, по которому играет реальный рейд.
        await accountAction(ctx, account.id, now, (synced) => ({
          account: credit(synced, techTarget('stanium'), stanium, {
            ts: now,
            reason: 'admin',
            refType: null,
            refId: 'dev_seed',
            idempotencyKey: null
          }).account,
          meta: null
        }));
        const charged = await chargeStanium(deps, account.id, stanium, now, {});
        field = charged.field.until ?? null;
      }
      const fresh = await ctx.users.findById(account.id);
      seeded.push({
        userId: account.id,
        socialId,
        rating: fresh?.pvp.rating ?? account.pvp.rating,
        staniumField: field ? field.toISOString() : null
      });
    }
    ctx.logger.info('dev_seed_opponents', { count: seeded.length, stanium });
    return { result: { seeded } };
  });

  app.post('/v1/dev/payments/confirm', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const body = bodyOf(request);
    const orderId = stringOf(body, 'orderId', 128);
    const fulfilled = await confirmPayment(
      deps,
      orderId,
      {
        providerOrderId: optionalStringOf(body, 'providerOrderId', 64),
        item: optionalStringOf(body, 'item', 64),
        votes: body['votes'] === undefined || body['votes'] === null ? null : intOf(body, 'votes', { min: 0 })
      },
      now,
      ctx.config.economy
    );
    ctx.logger.info('dev_payment_confirmed', { orderId, userId: fulfilled.userId, granted: fulfilled.granted });
    return {
      ...viewOf(ctx.config, fulfilled.account, now),
      result: { order: fulfilled.order, granted: fulfilled.granted, duplicate: fulfilled.duplicate }
    };
  });

  app.post('/v1/dev/payments/refund', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const orderId = stringOf(bodyOf(request), 'orderId', 128);
    const refunded = await refundPayment(deps, orderId, now, ctx.config.economy);
    ctx.logger.info('dev_payment_refunded', { orderId, userId: refunded.userId });
    return {
      ...viewOf(ctx.config, refunded.account, now),
      result: { order: refunded.order, granted: refunded.granted, duplicate: refunded.duplicate }
    };
  });

  app.get('/v1/dev/account', auth, async (request) => {
    assertDevRoutes(ctx);
    const account = await accountOf(ctx, request);
    // Сырой документ, включая отрицательные кошельки: витрина часть состояния
    // нормализует, а долговые сценарии надо смотреть по оригиналу.
    return { account };
  });
}

// ─── Выдача баланса ───────────────────────────────────────────────────────────────

interface Grant {
  target: BalanceTarget;
  amount: number;
}

const ALLOWED_GRANT_FIELDS: string[] = [
  ...MINING_RESOURCES,
  'energy',
  // SEC — не руда: он не майнится складом и не собирается рукой, а накапает тиком.
  // Без печати на стенде нельзя проверить ни витрину кошелька, ни трату монеты.
  'sec',
  'asteriumPurchased',
  'asteriumEarned',
  ...CRAFT_TECH_IDS,
  ...METAL_IDS,
  ...JUNK_IDS
];

function collectGrants(body: Record<string, unknown>): Grant[] {
  const grants: Grant[] = [];
  const take = (field: string, target: BalanceTarget): void => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') return;
    grants.push({ target, amount: intOf(body, field, { min: 0, max: 10_000_000 }) });
  };

  for (const id of MINING_RESOURCES) take(id, resourceTarget(id));
  take('energy', resourceTarget('energy'));
  take('sec', resourceTarget('sec'));
  take('asteriumPurchased', asterium('purchased'));
  take('asteriumEarned', asterium('earned'));
  for (const id of CRAFT_TECH_IDS as readonly CraftTechId[]) take(id, techTarget(id));
  for (const id of METAL_IDS as readonly MetalId[]) take(id, metalTarget(id));
  for (const id of JUNK_IDS as readonly JunkId[]) take(id, junkTarget(id));
  return grants;
}
