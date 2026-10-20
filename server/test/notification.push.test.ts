import { describe, expect, it } from 'vitest';

import { JUNK_IDS, type JunkId } from '../src/config/workshop.js';
import type { LogSink } from '../src/lib/logger.js';
import {
  NOTICE_MAX_CHARS,
  noticeRecipient,
  pluralize,
  renderSaleNotice,
  type LotSoldEvent
} from '../src/modules/notification/notice.types.js';
import { createNoticeOutbox, type NoticePolicy } from '../src/modules/notification/outbox.js';
import {
  isVkPushConfigured,
  sendVkPush,
  type FetchLike,
  type VkPushSettings
} from '../src/modules/notification/vk.push.js';

/**
 * VK Push о продаже (Часть 2, backlog 3).
 *
 * Проверяются три слоя по отдельности ровно так, как они разделены в коде:
 *  1. ТЕКСТ — чистая функция: продавец должен прочитать про ту сумму, которая
 *     реально легла ему на счёт (ТЗ предлагало сумму лота, то есть врать на комиссию);
 *  2. ТРАНСПОРТ — классификация отказа площадки: повторять или нет; здесь же —
 *     секрет вне URL и таймаут через AbortController;
 *  3. ОЧЕРЕДЬ — гейтинг, повторы, потолок и честная потеря при остановке.
 *
 * Сети нет ни в одном тесте: `fetch` подставляется, и именно это позволяет проверять
 * тексты и политики, не поднимая ВКонтакте.
 */

const PUSH: VkPushSettings = {
  appId: 53377165,
  secretKey: 'test-secret-key',
  endpoint: 'https://api.vk.test/method/secure.sendNotification',
  apiVersion: '5.199',
  timeoutMs: 50
};

function sale(over: Partial<LotSoldEvent> = {}): LotSoldEvent {
  return {
    lotId: 'lot-1',
    sellerId: 'user-seller',
    sellerPlatform: 'vk',
    sellerSocialId: '987654321',
    buyerId: 'user-buyer',
    junk: 'engines',
    amount: 3,
    grossSec: 15_000,
    netSec: 14_250,
    at: new Date('2026-10-18T00:00:00.000Z'),
    ...over
  };
}

interface Logged {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
}

/** Логгер в массив: политика очереди проверяется по её следам, а не по догадкам. */
function recordingSink(): LogSink & { records: Logged[]; msgs: () => string[] } {
  const records: Logged[] = [];
  const writer = (level: string) => (msg: string, meta?: Record<string, unknown>): void => {
    records.push({ level, msg, meta });
  };
  const sink = {
    records,
    msgs: (): string[] => records.map((r) => r.msg),
    trace: writer('trace'),
    debug: writer('debug'),
    info: writer('info'),
    warn: writer('warn'),
    error: writer('error'),
    fatal: writer('fatal')
  };
  return sink as unknown as LogSink & { records: Logged[]; msgs: () => string[] };
}

interface FetchReply {
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
  networkError?: string;
}

/** Сеть на палке: каждый вызов записывается, ответы идут по списку (последний — повторяется). */
function recordingFetch(replies: FetchReply[]): {
  fetch: FetchLike;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; params: Record<string, string> }>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; params: Record<string, string> }> = [];
  let index = 0;
  const impl: FetchLike = (url, init) => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      params: Object.fromEntries(new URLSearchParams(init.body).entries())
    });
    if (reply.networkError !== undefined) return Promise.reject(new Error(reply.networkError));
    const body = reply.body ?? { response: 1 };
    return Promise.resolve({
      status: reply.status ?? 200,
      json: (): Promise<unknown> =>
        reply.jsonThrows ? Promise.reject(new SyntaxError('Unexpected end of JSON input')) : Promise.resolve(body)
    });
  };
  return { fetch: impl, calls };
}

describe('notice.render: что именно прочитает продавец', () => {
  it('называет сумму, зачисленную на счёт, а не цену лота', () => {
    const text = renderSaleNotice(sale({ grossSec: 15_000, netSec: 14_250 }));
    expect(text).toContain('14250');
    // ТЗ писало `totalPriceSEC`. Написать её здесь — значит пообещать 15000, показать
    // в кошельке 14250 и получить тикет «рынок съел мои деньги».
    expect(text).not.toContain('15000');
  });

  it('объясняет разницу комиссией, а не оставляет её без слова', () => {
    const text = renderSaleNotice(sale({ grossSec: 1000, netSec: 950 }));
    expect(text).toContain('Комиссия рынка — 50 SEC.');
    expect(text.toLowerCase()).toContain('комиссия');
  });

  it('не позорит текст нулевой комиссией на дешёвом лоте', () => {
    // Комиссия округляется вниз, поэтому на мелком лоте она равна нулю
    // (config/market.ts), и «Комиссия рынка — 0 SEC» была бы правдой, которая путает.
    const text = renderSaleNotice(sale({ grossSec: 10, netSec: 10 }));
    expect(text).not.toContain('Комиссия');
  });

  it('склоняет вид хлама по русскому правилу, а не одним числом', () => {
    const chip = { one: 'микросхема', few: 'микросхемы', many: 'микросхем' };
    expect(pluralize(1, chip)).toBe('микросхема');
    expect(pluralize(2, chip)).toBe('микросхемы');
    expect(pluralize(5, chip)).toBe('микросхем');
    expect(pluralize(21, chip)).toBe('микросхема');
    expect(pluralize(111, chip)).toBe('микросхем');
    expect(pluralize(112, { one: 'плата', few: 'платы', many: 'плат' })).toBe('плат');
  });

  it('называет каждый вид по-русски и не вылезает за потолок длины', () => {
    for (const junk of JUNK_IDS as readonly JunkId[]) {
      for (const amount of [1, 2, 5, 21, 111, 1000]) {
        const text = renderSaleNotice(sale({ junk, amount, grossSec: 1_200_000, netSec: 1_140_000 }));
        expect(text).not.toContain(junk);
        expect(text.length).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
      }
    }
  });
});

describe('notice.recipient: кому вообще можно позвонить', () => {
  it('vk-игрок с числовым socialId получает id', () => {
    expect(noticeRecipient(sale({ sellerSocialId: '987654321' }))).toBe('987654321');
  });

  it('tg-игрок не получает ничего: пуш ВК физически некуда доставить', () => {
    expect(noticeRecipient(sale({ sellerPlatform: 'tg' }))).toBeNull();
  });

  it('нечисловой, пустой и слишком длинный id отбраковываются до всякой сети', () => {
    expect(noticeRecipient(sale({ sellerSocialId: '' }))).toBeNull();
    expect(noticeRecipient(sale({ sellerSocialId: 'abc' }))).toBeNull();
    expect(noticeRecipient(sale({ sellerSocialId: 'user-42' }))).toBeNull();
    expect(noticeRecipient(sale({ sellerSocialId: '1'.repeat(21) }))).toBeNull();
  });

  it('обрамляющие пробелы не повод терять уведомление', () => {
    expect(noticeRecipient(sale({ sellerSocialId: ' 42 ' }))).toBe('42');
  });
});

describe('vk.push: транспорт', () => {
  it('успех площадки — sent, и секрет уходит в тело, а не в URL', async () => {
    const net = recordingFetch([{ body: { response: 1 } }]);
    const result = await sendVkPush(PUSH, '987654321', 'Контрабанда доставлена', { fetch: net.fetch });

    expect(result).toEqual({ kind: 'sent', raw: 1 });
    expect(net.calls).toHaveLength(1);
    const call = net.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(PUSH.endpoint);
    expect(call?.url).not.toContain(PUSH.secretKey);
    expect(call?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call?.params['client_id']).toBe(String(PUSH.appId));
    expect(call?.params['client_secret']).toBe(PUSH.secretKey);
    expect(call?.params['user_ids']).toBe('987654321');
    expect(call?.params['message']).toBe('Контрабанда доставлена');
    expect(call?.params['v']).toBe(PUSH.apiVersion);
  });

  it('массивный ответ площадки читается как успех по первому адресату', async () => {
    const result = await sendVkPush(PUSH, '1', 'x', { fetch: recordingFetch([{ body: { response: [1] } }]).fetch });
    expect(result.kind).toBe('sent');
  });

  it('отказ в правах (6.13.2) — permanent: повторять бессмысленно, нужны руки', async () => {
    const net = recordingFetch([{ body: { error: { error_code: 6, error_msg: 'permission error' } } }]);
    const result = await sendVkPush(PUSH, '1', 'x', { fetch: net.fetch });
    expect(result).toEqual({ kind: 'permanent', code: 6, message: 'permission error' });
  });

  it('несовместимый токен (113) и неверный user_id (131) — permanent', async () => {
    for (const code of [113, 131, 5, 15, 17]) {
      const result = await sendVkPush(PUSH, '1', 'x', {
        fetch: recordingFetch([{ body: { error: { error_code: code, error_msg: `code ${code}` } } }]).fetch
      });
      expect(result.kind).toBe(code === 5 ? 'retryable' : 'permanent');
    }
  });

  it('перегрузка (5) и HTTP 429/500 — retryable: состояние площадки, а не настройки', async () => {
    const byCode = await sendVkPush(PUSH, '1', 'x', {
      fetch: recordingFetch([{ body: { error: { error_code: 5, error_msg: 'to many requests' } } }]).fetch
    });
    expect(byCode.kind).toBe('retryable');

    for (const status of [429, 500, 502, 503]) {
      const result = await sendVkPush(PUSH, '1', 'x', {
        fetch: recordingFetch([{ status, body: {} }]).fetch
      });
      expect(result.kind).toBe('retryable');
    }
  });

  it('прочие 4xx — permanent: это не временное состояние сети', async () => {
    const result = await sendVkPush(PUSH, '1', 'x', { fetch: recordingFetch([{ status: 404, body: {} }]).fetch });
    expect(result.kind).toBe('permanent');
  });

  it('сломанное тело ответа и сетевой отказ — retryable, а не исключение наружу', async () => {
    const broken = await sendVkPush(PUSH, '1', 'x', {
      fetch: recordingFetch([{ status: 502, jsonThrows: true }]).fetch
    });
    expect(broken.kind).toBe('retryable');

    const offline = await sendVkPush(PUSH, '1', 'x', {
      fetch: recordingFetch([{ networkError: 'ECONNRESET' }]).fetch
    });
    expect(offline).toEqual({ kind: 'retryable', code: null, message: 'ECONNRESET' });
  });

  it('неконфигурированный транспорт не делает ни одного запроса', async () => {
    const net = recordingFetch([]);
    const result = await sendVkPush({ ...PUSH, appId: 0, secretKey: '' }, '1', 'x', { fetch: net.fetch });
    expect(result.kind).toBe('permanent');
    expect(net.calls).toHaveLength(0);
    expect(isVkPushConfigured({ appId: 0, secretKey: '' })).toBe(false);
    expect(isVkPushConfigured(PUSH)).toBe(true);
  });

  it('невалидный адресат и пустой текст отсекаются до сети', async () => {
    const net = recordingFetch([]);
    expect((await sendVkPush(PUSH, 'abc', 'x', { fetch: net.fetch })).kind).toBe('permanent');
    expect((await sendVkPush(PUSH, '1', '', { fetch: net.fetch })).kind).toBe('permanent');
    expect(net.calls).toHaveLength(0);
  });
});

const POLICY: NoticePolicy = { enabled: true, capacity: 50, attempts: 2, drainIntervalMs: 1000 };

function harness(
  policy: Partial<NoticePolicy> = {},
  replies: FetchReply[] = [{ body: { response: 1 } }]
): {
  box: ReturnType<typeof createNoticeOutbox>;
  net: ReturnType<typeof recordingFetch>;
  logger: ReturnType<typeof recordingSink>;
} {
  const net = recordingFetch(replies);
  const logger = recordingSink();
  const box = createNoticeOutbox({
    push: PUSH,
    policy: { ...POLICY, ...policy },
    logger,
    fetch: net.fetch
  });
  return { box, net, logger };
}

/**
 * Ручные таймеры цикла. `fire()` СНИМАЕТ вызванный колбэк, как это делает настоящий
 * `setTimeout`: без этого `stop()` не мог бы отличить ожидающий тик от уже отработавшего,
 * и тест «очередь остановлена» проверял бы свою же карту, а не код.
 */
function loopTimers(): { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void; size: () => number; fire: () => void } {
  const scheduled = new Map<number, () => void>();
  let handle = 0;
  return {
    setTimeout: (fn: () => void, _ms: number) => {
      handle += 1;
      scheduled.set(handle, fn);
      return handle;
    },
    clearTimeout: (id: unknown) => {
      scheduled.delete(id as number);
    },
    size: () => scheduled.size,
    fire: () => {
      const jobs = [...scheduled.entries()];
      scheduled.clear();
      for (const [, job] of jobs) job();
    }
  };
}

describe('notice.outbox: политика доставки', () => {
  it('выключенный пуш не ходит в сеть и не копит очередь', async () => {
    const { box, net, logger } = harness({ enabled: false });
    expect(box.enqueue(sale())).toBe(false);
    expect(box.size()).toBe(0);
    expect((await box.drain()).sent).toBe(0);
    expect(net.calls).toHaveLength(0);
    expect(box.readiness().enabled).toBe(false);
    expect(logger.msgs()).toEqual([]);
  });

  it('включённый пуш без ключей называется отдельно от «выключен»', () => {
    const { box } = harness();
    const unconfigured = createNoticeOutbox({
      push: { ...PUSH, appId: 0, secretKey: '' },
      policy: POLICY,
      logger: recordingSink(),
      fetch: recordingFetch([]).fetch
    });
    expect(box.readiness()).toEqual({ enabled: true, configured: true, reason: null });
    expect(unconfigured.readiness().configured).toBe(false);
    expect(unconfigured.readiness().reason).toContain('VK_APP_ID');
    expect(unconfigured.enqueue(sale())).toBe(false);
  });

  it('tg-продавец отбраковывается на входе и не засоряет лог предупреждением', async () => {
    const { box, net, logger } = harness();
    expect(box.enqueue(sale({ sellerPlatform: 'tg' }))).toBe(false);
    expect(box.size()).toBe(0);
    expect(net.calls).toHaveLength(0);
    expect(logger.msgs()).toEqual(['notice_undeliverable']);
    expect(logger.records[0]?.level).toBe('debug');
  });

  it('продажа уходит площадкой ровно один раз и с текстом о зачисленной сумме', async () => {
    const { box, net, logger } = harness();
    expect(box.enqueue(sale({ grossSec: 15_000, netSec: 14_250, junk: 'chips', amount: 2 }))).toBe(true);
    const report = await box.drain();

    expect(report).toEqual({ sent: 1, deferred: 0, lost: 0, dropped: 0, queued: 0 });
    expect(net.calls).toHaveLength(1);
    const message = net.calls[0]?.params['message'] ?? '';
    expect(message).toContain('14250');
    expect(message).toContain('микросхемы');
    expect(logger.msgs()).toEqual(['notice_sent']);
    expect(box.stats().sent).toBe(1);
  });

  it('временный отказ повторяется, а по исчерпании попыток теряется с error-логом', async () => {
    const { box, net, logger } = harness({ attempts: 2 }, [{ status: 429 }]);
    box.enqueue(sale());

    expect((await box.drain()).deferred).toBe(1);
    expect(box.size()).toBe(1);
    expect((await box.drain()).deferred).toBe(1);
    const last = await box.drain();

    expect(last.lost).toBe(1);
    expect(last.deferred).toBe(0);
    expect(box.size()).toBe(0);
    expect(net.calls).toHaveLength(3);
    expect(logger.msgs()).toEqual(['notice_deferred', 'notice_deferred', 'notice_failed']);
    expect(logger.records[2]?.level).toBe('error');
  });

  it('постоянный отказ не повторяется никогда', async () => {
    const { box, net, logger } = harness({}, [
      { body: { error: { error_code: 6, error_msg: 'permission error' } } }
    ]);
    box.enqueue(sale());
    const report = await box.drain();

    expect(report.lost).toBe(1);
    expect(report.deferred).toBe(0);
    expect(net.calls).toHaveLength(1);
    expect(logger.msgs()).toEqual(['notice_rejected']);
    expect(logger.records[0]?.meta?.code).toBe(6);
  });

  it('потолок очереди вытесняет древнейшее: свежая продажа горячее', async () => {
    const { box, logger } = harness({ capacity: 2 });
    expect(box.enqueue(sale({ lotId: 'lot-old' }))).toBe(true);
    expect(box.enqueue(sale({ lotId: 'lot-mid' }))).toBe(true);
    expect(box.enqueue(sale({ lotId: 'lot-new' }))).toBe(true);

    expect(box.size()).toBe(2);
    expect(logger.msgs()).toEqual(['notice_dropped']);
    expect(logger.records[0]?.meta?.lotId).toBe('lot-old');
    expect(box.stats().dropped).toBe(1);
  });

  it('остановка теряет недоставанное, но называет lotId — вернуть можно только руками', async () => {
    const { box, logger } = harness();
    box.enqueue(sale({ lotId: 'lot-pending' }));
    await box.stop();

    expect(box.size()).toBe(0);
    expect(logger.msgs()).toEqual(['notice_lost_on_stop']);
    expect(logger.records[0]?.meta?.lots).toEqual(['lot-pending']);
    expect(box.stats().lost).toBe(1);
  });

  it('фоновый цикл разбирает очередь по таймеру и молчит на пустой', async () => {
    const net = recordingFetch([{ body: { response: 1 } }]);
    const logger = recordingSink();
    const timers = loopTimers();
    const box = createNoticeOutbox({
      push: PUSH,
      policy: POLICY,
      logger,
      fetch: net.fetch,
      timers
    });

    box.start();
    expect(timers.size()).toBe(1);

    // Пустой проход не имеет права ходить в сеть: рынок молчит большую часть суток,
    // и каждый тик, оставляющий след в логе, сделал бы лог бесполезным.
    timers.fire();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(net.calls).toHaveLength(0);
    expect(logger.msgs()).toEqual([]);
    expect(timers.size()).toBe(1);

    box.enqueue(sale());
    timers.fire();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(net.calls).toHaveLength(1);
    expect(logger.msgs()).toContain('notice_sent');
    expect(box.size()).toBe(0);

    await box.stop();
    expect(timers.size()).toBe(0);
  });
});
