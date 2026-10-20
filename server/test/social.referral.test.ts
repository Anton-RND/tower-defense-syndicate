import { describe, expect, it } from 'vitest';

import {
  REFERRAL_REWARD_ASTERIUM,
  REFERRAL_REWARD_ENERGY,
  applyReferralOnSignup,
  bindReferral,
  creditInviter,
  parseReferral,
  referralRef
} from '../src/modules/social/referral.js';
import { T0, addMs, newAccount, testConfig, withAsterium, withReferral, withResources } from './fixtures.js';

/**
 * «Пригласи друга» (Часть 2 ТЗ, серверная половина).
 *
 * Главный инвариант: награда — один раз на приглашённого, и она не зависит от того,
 * сколько раз клиент сообщил о клике. Второй: энергия урезается капом, но
 * приглашение всё равно засчитывается (иначе полный шкаф превращается в бесконечный
 * ретрай за наградой).
 */

const config = testConfig();
const rules = config.economy;

describe('social/referral: разбор ref-параметра', () => {
  it('принимает только наш префикс и валидную длину id', () => {
    expect(parseReferral('inv_0f1e2d3c')).toBe('0f1e2d3c');
    expect(parseReferral(referralRef('12345678-1234-1234-1234-1234567890ab'))).toBe(
      '12345678-1234-1234-1234-1234567890ab'
    );
  });

  it('отвергает чужие метки, мусор и слишком короткие id', () => {
    expect(parseReferral(null)).toBeNull();
    expect(parseReferral(undefined)).toBeNull();
    expect(parseReferral('')).toBeNull();
    expect(parseReferral('vk_share_panel')).toBeNull();
    expect(parseReferral('inv_ab')).toBeNull();
    expect(parseReferral('inv_')).toBeNull();
    expect(parseReferral('inv_bad id!')).toBeNull();
    expect(parseReferral('INV_0f1e2d3c')).toBeNull();
  });

  it('отрезает хвост query, который WebView иногда приносит вместе с ref', () => {
    expect(parseReferral('inv_0f1e2d3c&foo=1')).toBe('0f1e2d3c');
    expect(parseReferral('  inv_0f1e2d3c  ')).toBe('0f1e2d3c');
  });
});

describe('social/referral: привязка приглашённого', () => {
  it('ставит invitedBy один раз и навсегда', () => {
    const invitee = newAccount(config, T0, '100');
    const bound = bindReferral(invitee, 'inv_inviter-000001', T0);
    expect(bound.referral.invitedBy).toBe('inviter-000001');

    // Повторный запуск с чужой ссылкой: связка не перезаписывается, иначе «пригласи
    // друга» превращается в передачу долга между пригласившими.
    const again = bindReferral(bound, 'inv_inviter-000002', addMs(T0, 60_000));
    expect(again.referral.invitedBy).toBe('inviter-000001');
  });

  it('молчит на чужом ref, на пустом и на ссылке на самого себя', () => {
    const invitee = newAccount(config, T0, '101');
    expect(bindReferral(invitee, null, T0)).toBe(invitee);
    expect(bindReferral(invitee, 'unknown_tag', T0)).toBe(invitee);
    expect(bindReferral(invitee, referralRef(invitee.id), T0).referral.invitedBy).toBeNull();
  });
});

describe('social/referral: награда пригласившему', () => {
  it('выдаёт энергию и заработанный астериев одним редуктором, с черновиками журнала', () => {
    const inviter = withResources(newAccount(config, T0, '200'), { energy: 10 });
    const result = creditInviter(inviter, 'invitee-1', T0, rules);

    expect(result.credited).toBe(true);
    expect(result.energy).toBe(REFERRAL_REWARD_ENERGY);
    expect(result.asterium).toBe(REFERRAL_REWARD_ASTERIUM);
    expect(result.account.resources.energy).toBe(10 + REFERRAL_REWARD_ENERGY);
    expect(result.account.materials.asterium.earned).toBe(REFERRAL_REWARD_ASTERIUM);
    // Астерий за приглашение — только `earned`: купленные за рубли единицы приходят
    // из платежей, и примешивать сюда виральную выдачу нельзя.
    expect(result.account.materials.asterium.purchased).toBe(0);
    expect(result.drafts).toHaveLength(2);
    expect(new Set(result.drafts.map((draft) => draft.reason))).toEqual(new Set(['event']));
    expect(result.drafts.every((draft) => draft.idempotencyKey)).toBe(true);
  });

  it('полный шкаф не даёт энергию, но приглашение засчитывает', () => {
    const inviter = withResources(newAccount(config, T0, '201'), { energy: rules.energyCap });
    const result = creditInviter(inviter, 'invitee-2', T0, rules);

    expect(result.credited).toBe(true);
    expect(result.energy).toBe(0);
    expect(result.account.resources.energy).toBe(rules.energyCap);
    expect(result.drafts.map((draft) => draft.currency)).not.toContain('energy');
    expect(result.account.referral.invited).toContain('invitee-2');
  });

  it('повтор того же приглашённого — отказ без единого движения', () => {
    const inviter = withResources(newAccount(config, T0, '202'), { energy: 10 });
    const first = creditInviter(inviter, 'invitee-3', T0, rules);
    const second = creditInviter(first.account, 'invitee-3', addMs(T0, 1000), rules);

    expect(second.credited).toBe(false);
    expect(second.reason).toBe('already');
    expect(second.drafts).toEqual([]);
    expect(second.account).toBe(first.account);
  });

  it('самоприглашение не работает: invitee === inviter', () => {
    const inviter = newAccount(config, T0, '203');
    const result = creditInviter(inviter, inviter.id, T0, rules);
    expect(result.credited).toBe(false);
    expect(result.reason).toBe('self');
    expect(result.drafts).toEqual([]);
  });

  it('суточный потолок держит, а смена суток обнуляет счётчик', () => {
    const limited = testConfig({ REFERRAL_DAILY_MAX: '2' });
    const inviter = withResources(newAccount(limited, T0, '204'), { energy: 0 });

    const first = creditInviter(inviter, 'a-1', T0, limited.economy);
    const second = creditInviter(first.account, 'a-2', addMs(T0, 1000), limited.economy);
    const third = creditInviter(second.account, 'a-3', addMs(T0, 2000), limited.economy);

    expect(third.credited).toBe(false);
    expect(third.reason).toBe('limit');
    expect(third.drafts).toEqual([]);
    expect(second.account.referral.count).toBe(2);

    const nextDay = creditInviter(third.account, 'a-3', addMs(T0, 24 * 3600_000), limited.economy);
    expect(nextDay.credited).toBe(true);
    expect(nextDay.account.referral.count).toBe(1);
  });

  it('история приглашений обрезается потолком конфига (документ != бесконечность)', () => {
    const limited = testConfig({ REFERRAL_DAILY_MAX: '0' });
    let inviter = withResources(newAccount(limited, T0, '205'), { energy: 0 });
    for (let index = 0; index < 150; index += 1) {
      inviter = creditInviter(inviter, `invitee-${index}`, T0, limited.economy).account;
    }
    expect(inviter.referral.invited.length).toBeLessThanOrEqual(limited.economy.limits.referral.history);
  });
});

describe('social/referral: сборка на регистрации', () => {
  it('привязывает новичка и награждает пригласившего за один проход', () => {
    const inviter = withResources(newAccount(config, T0, '300'), { energy: 0 });
    const invitee = newAccount(config, addMs(T0, 1000), '301');

    const binding = applyReferralOnSignup(invitee, referralRef(inviter.id), inviter, addMs(T0, 1000), rules);
    expect(binding.invitee.referral.invitedBy).toBe(inviter.id);
    expect(binding.inviter?.credited).toBe(true);
    expect(binding.inviter?.account.referral.invited).toContain(binding.invitee.id);
    expect(binding.inviter?.drafts.length).toBeGreaterThan(0);
  });

  it('не награждает, если пригласивший не найден (ref на удалённый аккаунт)', () => {
    const invitee = newAccount(config, T0, '302');
    const binding = applyReferralOnSignup(invitee, 'inv_ghost-000001', null, T0, rules);
    expect(binding.invitee.referral.invitedBy).toBe('ghost-000001');
    expect(binding.inviter).toBeNull();
  });

  it('астериев падает в earned, а не в purchased', () => {
    const inviter = withAsterium(withResources(newAccount(config, T0, '303'), { energy: 0 }), 100, 0);
    const result = creditInviter(inviter, 'invitee-9', T0, rules);
    expect(result.account.materials.asterium).toEqual({ purchased: 100, earned: REFERRAL_REWARD_ASTERIUM });
  });

  it('referral пуст у нового аккаунта и его копия изолирована', () => {
    const account = newAccount(config, T0, '304');
    expect(account.referral).toEqual({
      invitedBy: null,
      creditedAt: null,
      day: '2026-10-18',
      count: 0,
      invited: []
    });
    const patched = withReferral(account, { invited: ['x-1'], count: 1 });
    patched.referral.invited.push('x-2');
    expect(account.referral.invited).toEqual([]);
  });
});