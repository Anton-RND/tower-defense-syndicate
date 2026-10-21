import type { FastifyInstance } from 'fastify';

import { AppError, ErrorCodes, forbidden, validationError } from '../../lib/errors.js';
import { verifyVkInitData, type ReferralClaim, type SocialIdentity, type VkVerificationResult } from '../../modules/auth/vk.adapter.js';
import { diagnoseVkInitData, formatVkPass } from '../../modules/auth/vk.signature.js';
import type { LedgerDraft } from '../../modules/ledger/ledger.types.js';
import {
  bindReferral,
  creditInviter,
  markReferralSettled,
  needsReferralSettle,
  parseReferral,
  referralRef,
  type ReferralCredit
} from '../../modules/social/referral.js';
import { applyStarterKit } from '../../modules/user/starter.js';
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
 *
 * ТРЕТИЙ УЧАСТНИК ВХОДА — стартовый комплект (config/starter.ts). Он выдаётся
 * здесь, в единственной точке рождения аккаунта, а не в `createAccount`: тот
 * вызывается и для спарринг-ботов (/v1/dev/seed-opponents), которым комплект не
 * нужен — их задача держать оборону, а не играть. Комплект начисляется через
 * `gainMaterials` с причиной `starter`, поэтому каждое зерно стартового железа
 * имеет запись в журнале.
 *
 * ЧЕТВЁРТЫЙ — реферал (modules/social/referral.ts), и он привязан ровно к тому же
 * месту: награда рождается из факта РЕГИСТРАЦИИ, поэтому и связывается она только
 * здесь, где этот факт известен (`created === true`). Три закона, без которых
 * «пригласи друга» — принтер астериев:
 *   1. заявка из неподписанного `hash` рассматривается ТОЛЬКО на новом аккаунте;
 *   2. сама награда считается referral-модулем: один приглашённый = одна награда,
 *      суточный потолок, запрет самоприглашения;
 *   3. связка и награда лежат в РАЗНЫХ документах, и отметка `referral.settledAt`
 *      на документе новичка говорит, что второй документ уже тронут. Без неё
 *      падение процесса между двумя записями молча стоило бы пригласившему
 *      награды навсегда: на следующем входе `invitedBy` занят, и заявка из `hash`
 *      больше не рассматривается (закон 1).
 */

type Identity = Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>;

/** Причина, по которой реферал не принёс награды — наружу, в лог и в ответ витрине. */
export type ReferralReason =
  | 'ok'
  | 'not-ours'
  | 'self'
  | 'already-bound'
  | 'already-credited'
  | 'inviter-not-found'
  | 'limit';

export interface ReferralOutcome {
  /** Сырая метка из initData (`inv_<uuid>`, `vk_share_panel`, …). */
  ref: string;
  /**
   * Откуда метка: `signed`/`hash` — из пришедшей initData, `stored` — из уже
   * сохранённой связки новичка (догон награды после падения процесса).
   */
  source: 'signed' | 'hash' | 'stored';
  /** true — новичок закреплён за пригласившим (даже если награды не вышло). */
  bound: boolean;
  credited: boolean;
  reason: ReferralReason;
  /** Начислено пригласившему (0 — отказ или переполненный шкаф). */
  energy: number;
  asterium: number;
}

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
  // Черновики в массиве, а не в переменной: TS не отслеживает присваивания внутри
  // колбэка (тот же приём, что в helpers.accountAction и pvp/raid.commitRaid).
  const captured: LedgerDraft[][] = [];
  const { account } = await ctx.users.getOrCreate(identity, now, (freshIdentity, at) => {
    const blank = createAccount(freshIdentity, at, ctx.config.economy, ctx.idFactory);
    const starter = applyStarterKit(blank, at);
    captured.length = 0;
    captured.push(starter.drafts);
    return starter.account;
  });
  // Порядок «сначала состояние, потом журнал» — единственный допустимый в проекте
  // (шапка helpers.ts). Комплект вшит в сам документ при создании, поэтому падение
  // записи не оставляет игрока с нулями: он сохранится, а потерянный аудиторский
  // след виден в логе и добирается Support-инструментом.
  const drafts = captured[captured.length - 1] ?? [];
  if (drafts.length > 0) {
    const written = await ctx.ledger.appendMany(drafts.map((draft) => ({ ...draft, id: ctx.idFactory() })));
    if (written < drafts.length) {
      ctx.logger.warn('starter_drafts_dropped', {
        userId: account.id,
        expected: drafts.length,
        written
      });
    }
  }
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

/** Метка из голого тела запроса (dev-login, будущие deep-link'и) → та же заявка. */
function claimOfRef(ref: string): ReferralClaim {
  return { raw: ref, source: 'hash', inviterId: parseReferral(ref) };
}

/**
 * Заявка из УЖЕ СОХРАНЁННОЙ связки новичка → тот же разбор.
 *
 * Источник доверия здесь выше, чем у `hash`: `invitedBy` написал сервер, а не
 * клиент. Форма `inv_<id>` прогоняется через parseReferral на равных с остальными
 * — лишняя ветка «для догона» означала бы второй путь, по которому антифрод
 * referral.ts не проходит.
 */
function claimOfBinding(inviterId: string): ReferralClaim {
  return { raw: referralRef(inviterId), source: 'stored', inviterId };
}

const emptyOutcome = (claim: ReferralClaim, reason: ReferralReason): ReferralOutcome => ({
  ref: claim.raw,
  source: claim.source,
  bound: false,
  credited: false,
  reason,
  energy: 0,
  asterium: 0
});

/** Причины отказа модуля → причины в ответе витрины: `already` читается как «уже награждён». */
function reasonOfCredit(credit: ReferralCredit): ReferralReason {
  return credit.reason === 'ok' ? 'ok' : credit.reason === 'already' ? 'already-credited' : credit.reason;
}

/**
 * Отметка «связка обработана» на документе новичка.
 *
 * Ставится при любом исходе, включая отказ: без неё лимит приглашений и
 * удалённый пригласивший переигрывались бы на каждом входе.
 */
async function markSettled(ctx: AppContext, inviteeId: string, now: Date): Promise<void> {
  await ctx.users.transact(inviteeId, (current) => markReferralSettled(current, now));
}

/**
 * Разбор заявки: связка новичка → награда пригласившему → отметка о догоне.
 *
 * Вызывается из двух мест, и это единственные два пути в рефералах:
 *   • `applyReferralClaim` с заявкой из initData — на рождении аккаунта;
 *   • `settleStoredReferral` с заявкой из документа новичка — на любом следующем
 *     входе, если прошлый оборвался между двумя записями.
 *
 * И в том, и в другом случае правило одно: награда считается referral-модулем, а
 * не этим файлом. Здесь только порядок записей и отметка `settledAt`.
 */
async function applyReferralClaim(
  ctx: AppContext,
  invitee: UserAccount,
  claim: ReferralClaim,
  now: Date
): Promise<ReferralOutcome> {
  const inviterId = claim.inviterId;
  // Не наш ref (`vk_share_panel`, маркетинговый тег, мусор) — молча проходим мимо:
  // метка чужая, и наказывать за неё игрока отказом входа было бы абсурдом.
  // `settledAt` не ставим: новичок ни к кому не привязан, догонять нечего.
  if (inviterId === null) return emptyOutcome(claim, 'not-ours');
  if (inviterId === invitee.id) return emptyOutcome(claim, 'self');

  // 1. Новичок принимает связку. Само правило «один раз и навсегда» живёт в
  //    referral.bindReferral — здесь больше нет второй его копии, иначе она
  //    разошлась бы с первой ровно тогда, когда это дорого стоит.
  const bound = await ctx.users.transact(invitee.id, (current) => bindReferral(current, claim.raw, now));
  if (bound.referral.invitedBy !== inviterId) return emptyOutcome(claim, 'already-bound');

  // 2. Пригласивший. Ссылка на удалённый аккаунт — отметку ставим всё равно:
  //    повторять эту попытку при каждом входе новичка смысла нет, а вот молча
  //    оставить её незакрытой — значит получить `referral_settled` в логах.
  const inviter = await ctx.users.findById(inviterId);
  if (!inviter) {
    await markSettled(ctx, bound.id, now);
    return { ...emptyOutcome(claim, 'inviter-not-found'), bound: true };
  }

  // Редуктор награды живёт ВНУТРИ транзакции пригласившего: `creditInviter` —
  // чистая функция, и считать её по документу, прочитанному до блокировки,
  // значит терять начисления при конкурентной записи (тот же закон, что в
  // helpers.accountAction).
  const captured: ReferralCredit[] = [];
  await ctx.users.transact(inviterId, (current) => {
    const credit = creditInviter(current, bound.id, now, ctx.config.economy);
    captured.length = 0;
    captured.push(credit);
    return credit.account;
  });
  const credit = captured[captured.length - 1];
  if (!credit) {
    await markSettled(ctx, bound.id, now);
    return { ...emptyOutcome(claim, 'inviter-not-found'), bound: true };
  }

  if (credit.drafts.length > 0) {
    const written = await ctx.ledger.appendMany(credit.drafts.map((draft) => ({ ...draft, id: ctx.idFactory() })));
    if (written < credit.drafts.length) {
      ctx.logger.warn('referral_drafts_dropped', {
        inviterId,
        inviteeId: bound.id,
        expected: credit.drafts.length,
        written
      });
    }
  }

  // 3. Отметка «второй документ тронут». Последний шаг именно потому, что он
  //    дешёвый и однократный: до этого момента любое падение оставило бы
  //    новичка в состоянии «привязан, но не обработан», различимым только здесь.
  await markSettled(ctx, bound.id, now);

  const reason: ReferralReason = reasonOfCredit(credit);
  ctx.logger.info('referral_bind', {
    inviteeId: bound.id,
    inviterId,
    source: claim.source,
    ref: claim.raw,
    credited: credit.credited,
    reason,
    energy: credit.energy,
    asterium: credit.asterium,
    remainingToday: credit.remainingToday
  });

  return {
    ref: claim.raw,
    source: claim.source,
    bound: true,
    credited: credit.credited,
    reason,
    energy: credit.energy,
    asterium: credit.asterium
  };
}

/**
 * Догон награды по уже сохранённой связке.
 *
 * Ситуация, ради которой это существует: процесс упал между записью новичка и
 * наградой пригласившего. Заявка берётся НЕ из initData клиента, а из нашего же
 * документа, поэтому закон «hash только на новом аккаунте» не ослабевает —
 * атакующий не может приказывать догон: `invitedBy` он не пишет.
 *
 * Повторная награда невозможна дважды: `creditInviter` отказывает по списку
 * `invited` (идемпотентность по inviteeId), а `markSettled` закрывает дверь
 * после первой же попытки.
 */
async function settleStoredReferral(
  ctx: AppContext,
  account: UserAccount,
  now: Date
): Promise<ReferralOutcome | null> {
  if (!needsReferralSettle(account, now)) return null;
  const inviterId = account.referral.invitedBy;
  if (!inviterId) return null;

  const outcome = await applyReferralClaim(ctx, account, claimOfBinding(inviterId), now);
  ctx.logger.info('referral_settled', {
    inviteeId: account.id,
    inviterId,
    credited: outcome.credited,
    reason: outcome.reason
  });
  return outcome;
}

/**
 * Реферал не имеет права сорвать вход.
 *
 * Награда пригласившему — бонус поверх уже состоявшейся сессии: если отказал
 * стор, упал журнал или документ пригласившего уехал за пределы истории, игрок
 * всё равно обязан попасть в игру, а привязка обязана догнаться на следующем
 * входе (ровно для этого `settledAt` и остаётся null до полного успеха).
 *
 * Без этой обёртки ошибка в награде другу превращала бы `/v1/auth/vk/init-data`
 * в 500 — то есть социальная механика ломала вход целому поколению новичков.
 */
async function referralStep(
  ctx: AppContext,
  invitee: UserAccount,
  what: 'apply' | 'settle',
  run: () => Promise<ReferralOutcome | null>
): Promise<ReferralOutcome | null> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.warn('referral_step_failed', {
      inviteeId: invitee.id,
      what,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/** Итог входа: сессия плюс диагностика реферала, если метка приходила. */
function sessionWithReferral(
  ctx: AppContext,
  account: UserAccount,
  now: Date,
  created: boolean,
  referral: ReferralOutcome | null
) {
  return { ...sessionOf(ctx, account, now, created), ...(referral ? { referral } : {}) };
}

/**
 * Форма `socialId`, которую вообще стоит нести в ключ уникального индекса.
 *
 * Для боевого пути она не нужна: там id приходит из подписанных площадкой
 * параметров и проверется в vk.adapter на цифровость. Она нужна dev-login'y,
 * где тело пишет кто угодно.
 */
const SOCIAL_ID_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Проверка initData с обязательным следом об отказе.
 *
 * ПОЧЕМУ ЭТО ОБЯЗАТЕЛЬНО. Отказ входа по подписи — единственный сбой во всём
 * проекте, который невозможно воспроизвести: он случается на устройстве
 * реального игрока, в WebView площадки, где нет ни консоли, ни повтора. Если
 * сервер отвечает на него молчаливым 401, оператор узнаёт о нём из жалобы
 * «не заходит», и лечит наугад. Здесь же отказ оставляет четыре факта:
 *   • имя поля подписи и её ФОРМУ (hex64 = mini_app, base64url = launch_params) —
 *     форма не зависит от секрета, поэтому по ней «не тот секрет» отличается от
 *     «незнакомая схема» ещё до всякого сравнения;
 *   • имена параметров (значения — никогда: это персональные данные);
 *   • был ли `hash`;
 *   • перебранные комбинации с их результатами.
 *
 * Стоимость: четыре лишних HMAC только на пути отказа, который и так уже
 * потратил четыре. Бюджет входа (`guard('auth')`) ограничивает частоту.
 */
function verifyVkInitDataOrLogged(ctx: AppContext, initData: string, now: Date): VkVerificationResult {
  try {
    return verifyVkInitData(initData, ctx.config.vk, now);
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === ErrorCodes.INVALID_INIT_DATA || error.code === ErrorCodes.EXPIRED_INIT_DATA)
    ) {
      const diagnosis = diagnoseVkInitData(initData, {
        appId: ctx.config.vk.appId,
        secretKey: ctx.config.vk.secretKey
      });
      ctx.vkAuth.rejected({
        code: error.code,
        reason: typeof error.details?.['reason'] === 'string' ? (error.details['reason'] as string) : null,
        signKey: diagnosis.signKey,
        signShape: diagnosis.signShape,
        hashPresent: diagnosis.hashPresent,
        paramCount: diagnosis.paramCount
      });
      ctx.logger.warn('auth_vk_rejected', {
        code: error.code,
        reason: error.details?.['reason'] ?? null,
        signKey: diagnosis.signKey,
        signShape: diagnosis.signShape,
        signLength: diagnosis.signLength,
        hashPresent: diagnosis.hashPresent,
        paramCount: diagnosis.paramCount,
        paramKeys: diagnosis.paramKeys,
        passes: diagnosis.passes.map(formatVkPass)
      });
    }
    throw error;
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Бюджет на адрес, а не на игру: эти два маршрута — единственная необработанная
  // точка, где можно гадать по чужим initData и подбирать socialId вслепую.
  const authBudget = { preHandler: ctx.security.guard('auth') };

  app.post('/v1/auth/vk/init-data', authBudget, async (request) => {
    const body = bodyOf(request);
    const initData = stringOf(body, 'initData', 8192);
    const now = ctx.now();
    const verified = verifyVkInitDataOrLogged(ctx, initData, now);
    const identity = verified.identity;
    const { account, created } = await login(ctx, identity, now);
    // Реферал: свежая заявка принимается только на рождении аккаунта; на любом
    // следующем входе догоняется только то, что уже записано в документ новичка
    // (см. applyReferralClaim / settleStoredReferral).
    const claim = created ? verified.referral : null;
    const referral = claim
      ? await referralStep(ctx, account, 'apply', () => applyReferralClaim(ctx, account, claim, now))
      : await referralStep(ctx, account, 'settle', () => settleStoredReferral(ctx, account, now));
    ctx.vkAuth.accepted({
      scheme: verified.scheme,
      signKey: verified.signKey,
      source: verified.source,
      hashIncluded: verified.hashIncluded,
      tsKey: verified.tsKey
    });
    ctx.logger.info('auth_vk', {
      userId: account.id,
      created,
      scheme: verified.scheme,
      signKey: verified.signKey,
      signSource: verified.source,
      hashIncluded: verified.hashIncluded,
      tsKey: verified.tsKey,
      ref: verified.referral ? verified.referral.raw : null,
      refSource: verified.referral ? verified.referral.source : null,
      referral: referral ? referral.reason : null,
      // true — награда догнана позже, на повторном входе: значит прошлый запрос
      // оборвался между двумя документами, и это тот самый случай, который
      // иначе не увидел бы никто.
      referralRecovered: referral ? referral.source === 'stored' : null
    });
    return sessionWithReferral(ctx, account, now, created, referral);
  });

  app.post('/v1/auth/dev-login', authBudget, async (request) => {
    if (!ctx.config.devSignerEnabled) {
      throw forbidden('DEV_SIGNER_ENABLED выключен: вход по голому socialId разрешён только вне production');
    }
    const body = bodyOf(request);
    const socialId = optionalStringOf(body, 'socialId', 64) ?? '1';
    // Форма, а не любая строка: это единственный путь, где socialId приходит от
    // клиента без подписи площадки, и он же становится ключом уникального
    // индекса. Пробельные, управляющие и `&`-значения здесь не должны ездить.
    if (!SOCIAL_ID_SHAPE.test(socialId)) {
      throw validationError('Поле «socialId» обязано быть 1–64 символа [A-Za-z0-9_.-]', { field: 'socialId' });
    }
    const ref = optionalStringOf(body, 'ref', 128);
    const now = ctx.now();
    const identity: Identity = {
      platform: 'vk',
      socialId,
      appId: ctx.config.vk.appId > 0 ? String(ctx.config.vk.appId) : null,
      groupId: null
    };
    const { account, created } = await login(ctx, identity, now);
    // Тот же путь, что у боевого: dev-тело приходит из наших же рук, но реферал
    // обязан спотыкаться о те же правила антифрода, иначе стенд проверяет одну
    // ветку, а прод живёт по другой.
    const claim = created && ref ? claimOfRef(ref) : null;
    const referral = claim
      ? await referralStep(ctx, account, 'apply', () => applyReferralClaim(ctx, account, claim, now))
      : await referralStep(ctx, account, 'settle', () => settleStoredReferral(ctx, account, now));
    ctx.logger.info('auth_dev_login', {
      userId: account.id,
      socialId,
      created,
      referral: referral ? referral.reason : null,
      referralRecovered: referral ? referral.source === 'stored' : null
    });
    return sessionWithReferral(ctx, account, now, created, referral);
  });

  app.get('/v1/me', { preHandler: authHook(ctx) }, async (request) => {
    const claims = claimsOf(request);
    const account = await ctx.users.findById(claims.sub);
    if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId: claims.sub });
    return { session: claims, ...viewOf(ctx.config, account, ctx.now()) };
  });
}
