import type { LogSink } from '../../lib/logger.js';
import { createLoop, type Loop, type LoopTimers } from '../../lib/scheduler.js';
import { noticeRecipient, renderSaleNotice, type LotSoldEvent } from './notice.types.js';
import { isVkPushConfigured, sendVkPush, type FetchLike, type VkPushSettings } from './vk.push.js';

/**
 * Очередь уведомлений (Часть 2, backlog 3): политика доставки, а не транспорт.
 *
 * ПОЧЕМУ ОЧЕРЕДЬ, А НЕ «ОТПРАВИТЬ ИЗ МАРШРУТА». `await` отправки ВК внутри покупки
 * означал бы, что игрок ждёт чужой сети посреди денежного протокола: три секунды
 * таймаута на каждую сделку, и это в удачный день ВК. Хуже другое: если ВК лежит,
 * у нас встал бы и рынок, хотя деньги там уже разведены. Поэтому маршрут только
 * кладёт факт в очередь (`enqueue`, синхронно, без ожидания), а шлёт её фоновый
 * цикл из `lib/scheduler.ts`.
 *
 * AT-MOST-ONCE, И ЭТО СОЗНАТЕЛЬНО. Гарантию «ровно один пуш на продажу» дал бы только
 * отдельный журнал уведомлений с уникальным ключом — пятая учётная сущность ради
 * информации. Дедупликация сделана выше по потоку: право объявить продажу получает
 * лишь тот, кто реально записал выплату в журнал (см. `market/commit.ts`), поэтому
 * двойного пуша не бывает ни при какой гонке. Остаточный риск — пуш ПОТЕРЯЕТСЯ, если
 * процесс умрёт между зачислением денег и отправкой. Выбираем потерю: деньги у
 * продавца уже лежат, а запись `notice_lost_on_stop` говорит поддержке, кому именно
 * уведомление должно было прийти.
 *
 * ОДНА ОТПРАВКА ЗА РАЗ, БЕЗ ПАРАЛЛЕЛИЗМА. `secure.sendNotification` ограничивается
 * частотой на приложение, и веер из двадцати одновременных запросов на пике продаж
 * заработал бы нам 429 на всё остальное время. Последовательная очередь с паузой
 * между проходами медленнее на пике и предсказуемее в среднем.
 */

export interface NoticePolicy {
  /** Общий выключатель: `VK_PUSH_ENABLED=false` → очередь отказывает молча. */
  enabled: boolean;
  /** Потолок накопления: рынок может породить больше фактов, чем ВК пропустит за паузу. */
  capacity: number;
  /** Сколько ПОВТОРОВ на одно уведомление при временном отказе ВК (0 — один поход). */
  attempts: number;
  /** Как часто разбирать очередь: пуш чувствителен к задержке, минута здесь уже поздно. */
  drainIntervalMs: number;
}

export interface DrainReport {
  sent: number;
  /** Остались в очереди на следующий проход (временный отказ ВК). */
  deferred: number;
  /** Отброшены навсегда: отказ площадки либо исчерпанные повторы. */
  lost: number;
  /** Не влезли даже на повтор (потолок `capacity`). */
  dropped: number;
  /** Что осталось в очереди после прохода. */
  queued: number;
}

export interface NoticeOutboxStats {
  enqueued: number;
  refused: number;
  sent: number;
  lost: number;
  dropped: number;
  passes: number;
  size: number;
}

export interface NoticeReadiness {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
}

export interface NoticeOutbox {
  /**
   * Принять факт продажи. true — только если событие реально встало в очередь.
   * false означает «выключено / некому / не влезло», и это штатный исход: вызывающий
   * код (маршрут) не имеет права на него реагировать отказом игроку.
   */
  enqueue(event: LotSoldEvent): boolean;
  /** Один проход доставки. Публичный: нужен фоновому циклу, тестам и dev-ручке. */
  drain(): Promise<DrainReport>;
  start(): void;
  stop(): Promise<void>;
  size(): number;
  stats(): NoticeOutboxStats;
  /** Для диагностики и `/health`: настроен ли транспорт и чем именно. */
  readiness(): NoticeReadiness;
}

export interface NoticeOutboxDeps {
  push: VkPushSettings;
  policy: NoticePolicy;
  logger: LogSink;
  /** Транспорт по умолчанию — глобальный fetch; тесты подставляют свой. */
  fetch?: FetchLike;
  timers?: LoopTimers;
}

interface QueuedNotice {
  event: LotSoldEvent;
  /** Сколько раз уже попробовали: сравнивается с `policy.attempts` ДО повтора. */
  tries: number;
}

/** Приводит ответ глобального fetch к форме `FetchLike`: у `Response.json()` свой тип. */
function asFetchLike(response: Response): { status: number; json(): Promise<unknown> } {
  return { status: response.status, json: () => response.json() as Promise<unknown> };
}

export function createNoticeOutbox(deps: NoticeOutboxDeps): NoticeOutbox {
  const logger = deps.logger;
  const policy = deps.policy;
  const push = deps.push;
  const capacity = Math.max(1, policy.capacity);
  const fetchImpl: FetchLike =
    deps.fetch ??
    ((url, init) => fetch(url, init).then(asFetchLike));

  const queue: QueuedNotice[] = [];
  let counters = { enqueued: 0, refused: 0, sent: 0, lost: 0, dropped: 0, passes: 0 };

  function readiness(): NoticeReadiness {
    if (!policy.enabled) {
      return { enabled: false, configured: isVkPushConfigured(push), reason: 'VK_PUSH_ENABLED=false' };
    }
    if (!isVkPushConfigured(push)) {
      return { enabled: true, configured: false, reason: 'VK_APP_ID/VK_SECRET_KEY не заданы' };
    }
    return { enabled: true, configured: true, reason: null };
  }

  function enqueue(event: LotSoldEvent): boolean {
    const ready = readiness();
    if (!ready.enabled || !ready.configured) {
      counters.refused += 1;
      return false;
    }
    if (noticeRecipient(event) === null) {
      // tg-игрок или нечисловой socialId: не порча данных, а свойство площадки —
      // такому адресату звонить некуда. debug, а не warn: на tg-сервере это был бы
      // лог на каждую сделку рынка.
      counters.refused += 1;
      logger.debug('notice_undeliverable', {
        lotId: event.lotId,
        sellerId: event.sellerId,
        platform: event.sellerPlatform
      });
      return false;
    }
    if (queue.length >= capacity) {
      // Вытесняем ДРЕВНЕЙШЕЕ, а не новое: свежая продажа горячее — игрок ещё помнит,
      // что выставил лот, а ждавший минуту уже успел зайти в игру и увидеть баланс.
      const evicted = queue.shift();
      counters.dropped += 1;
      logger.warn('notice_dropped', {
        lotId: evicted?.event.lotId ?? null,
        sellerId: evicted?.event.sellerId ?? null,
        capacity,
        why: 'queue_full'
      });
    }
    queue.push({ event, tries: 0 });
    counters.enqueued += 1;
    return true;
  }

  async function drain(): Promise<DrainReport> {
    counters.passes += 1;
    const report: DrainReport = { sent: 0, deferred: 0, lost: 0, dropped: 0, queued: 0 };
    // Снимаем срез, а не идём по живому массиву: `push` обратно во время итерации
    // сдвигал бы индексы, и часть уведомлений получилась бы по два запроса, а часть — по нулю.
    const batch = queue.splice(0, queue.length);

    for (const item of batch) {
      const userId = noticeRecipient(item.event);
      if (userId === null) {
        report.lost += 1;
        counters.lost += 1;
        continue;
      }
      const message = renderSaleNotice(item.event);
      const result = await sendVkPush(push, userId, message, { fetch: fetchImpl });

      if (result.kind === 'sent') {
        report.sent += 1;
        counters.sent += 1;
        logger.info('notice_sent', {
          lotId: item.event.lotId,
          sellerId: item.event.sellerId,
          netSec: item.event.netSec,
          tries: item.tries + 1
        });
        continue;
      }

      if (result.kind === 'permanent') {
        report.lost += 1;
        counters.lost += 1;
        // warn, а не error: это не наш сбой. Но и не debug — 6.13.2 значит, что фича
        // запрещена приложению на стороне ВК, и узнать об этом нужно из лога, а не
        // от игрока, пожаловавшегося, что ему не пришли.
        logger.warn('notice_rejected', {
          lotId: item.event.lotId,
          sellerId: item.event.sellerId,
          code: result.code,
          message: result.message
        });
        continue;
      }

      if (item.tries < Math.max(0, policy.attempts)) {
        item.tries += 1;
        if (queue.length < capacity) {
          queue.push(item);
          report.deferred += 1;
          logger.debug('notice_deferred', {
            lotId: item.event.lotId,
            code: result.code,
            message: result.message,
            tries: item.tries
          });
          continue;
        }
        report.dropped += 1;
        counters.dropped += 1;
        logger.warn('notice_dropped', { lotId: item.event.lotId, why: 'retry_overflow' });
      }

      report.lost += 1;
      counters.lost += 1;
      logger.error('notice_failed', {
        lotId: item.event.lotId,
        sellerId: item.event.sellerId,
        code: result.code,
        message: result.message,
        tries: item.tries
      });
    }

    report.queued = queue.length;
    return report;
  }

  const loop: Loop = createLoop({
    name: 'notice_outbox',
    intervalMs: policy.drainIntervalMs,
    run: async () => {
      if (queue.length === 0) return;
      await drain();
    },
    onError: (error, meta) => logger.error('notice_loop_error', { error: error.message, passes: meta.ticks }),
    timers: deps.timers
  });

  return {
    enqueue,
    drain,
    start(): void {
      if (!policy.enabled) return;
      loop.start();
    },
    async stop(): Promise<void> {
      await loop.stop();
      if (queue.length === 0) return;
      // Последний честный след: какие продажи остались без уведомления. Вернуть их
      // можно только руками по этому логу, поэтому здесь lotId, а не «много».
      logger.warn('notice_lost_on_stop', {
        count: queue.length,
        lots: queue.slice(0, 20).map((item) => item.event.lotId)
      });
      counters.lost += queue.length;
      queue.length = 0;
    },
    size: () => queue.length,
    stats: () => ({ ...counters, size: queue.length }),
    readiness
  };
}
