import { JUNK_LABELS, type JunkLabel } from '../../config/market.js';
import type { JunkId } from '../../config/workshop.js';
import type { Platform } from '../../config/env.js';

/**
 * Уведомления игроку (Часть 2, backlog 3): домен над фактом сделки, а не транспорт.
 *
 * ЗДЕСЬ НЕТ СЕТИ, ЛОГГЕРА И КОНФИГА. Только три вещи: что за факт породил
 * уведомление, как он звучит по-русски и кому он адресован. Транспорт — `vk.push.ts`,
 * планировщик доставки — `outbox.ts`. Тот же раздел ответственности, что у
 * `market/service.ts` (чистая математика) и `market/commit.ts` (порядок записей):
 * текст пуша обязан тестироваться без поднятого HTTP-сервера ВКонтакте, ровно как
 * коридор обязан тестироваться без Mongo.
 *
 * ПОЧЕМУ СООБЩЕНИЕ СОБИРАЕТ СЕРВЕР. Пуш уходит на телефон игрока тогда, когда его
 * клиент закрыт — в этот момент никакого фронтенда, знающего русские названия хлама,
 * в процессе нет. Держать копию этих строк на клиенте означало бы расходиться с
 * текстом пуша при первом же переименовании вида, поэтому названия живут в
 * `config/market.ts` и отдают и витрине, и пушу одни и те же слова.
 */

/** Факт «лот продан и деньги продавцу доведены». Рождается ровно один раз на лот. */
export interface LotSoldEvent {
  lotId: string;
  sellerId: string;
  /** Площадка продавца: пуш ВК tg-игроку физически некуда доставить. */
  sellerPlatform: Platform;
  /** Социальный id получателя (`vk_user_id` для площадки vk). */
  sellerSocialId: string;
  /**
   * Покупатель. `null` возможен только в гипотетическом лоте, доведённом reconcile
   * без захвата, — уведомление его не использует, он нужен для связи записей в логе.
   */
  buyerId: string | null;
  junk: JunkId;
  amount: number;
  /** Цена лота целиком, SEC: игрок помнит её, по ней он и выставил объявление. */
  grossSec: number;
  /**
   * Что реально зачислено продавцу — за вычетом комиссии.
   *
   * В тексте пуша обязана быть именно эта цифра. ТЗ предлагало `totalPriceSEC`, то
   * есть сумму лота: продавец прочитал бы «вам пришло 100 SEC», заглянул в кошелёк и
   * нашёл 95. Расхождение кошелька с уведомлением — это не недосказанность, а тикет
   * в поддержку и недоверие к рынку, поэтому пишем то, что легло на счёт, и
   * объясняем разницу комиссией.
   */
  netSec: number;
  at: Date;
}

/**
 * Потолок длины текста. `secure.sendNotification` принимает до 500 символов, но
 * уведомление на телефоне сворачивается гораздо раньше: всё, что не влезло в
 * извещение, игрок увидит только раскрыв его. Держим текст коротким принудительно,
 * иначе следующий, кто «добавит пару слов» в шаблон, молча упрётся в лимит площадки.
 */
export const NOTICE_MAX_CHARS = 180;

/** Кому вообще адресован этот факт: tg-игроку пуш ВК не доставить. */
export function noticeRecipient(event: LotSoldEvent): string | null {
  if (event.sellerPlatform !== 'vk') return null;
  const id = event.sellerSocialId.trim();
  // `secure.sendNotification` принимает числовой user_id. Строка вида «abc» или
  // пустой socialId — не кандидат на пуш, а кандидат на разбор данных: отправлять
  // такое в VK значит ловить 113/131 на каждой сделке.
  if (!/^\d{1,20}$/.test(id)) return null;
  return id;
}

/** Русский вид хлама для текста; неизвестный вид отдаётся как есть, а не «пусто». */
function junkLabel(junk: JunkId): JunkLabel {
  return JUNK_LABELS[junk] ?? { one: junk, few: junk, many: junk };
}

/**
 * Текст уведомления о продаже.
 *
 * ЧИСТОЕ ЧИСЛО БЕЗ ОКРУГЛЕНИЯ: `netSec`/`grossSec` приходят целыми монетами из
 * домена (`lotNet` уже вычитает комиссию с округлением вниз), и округлять их здесь
 * значило бы иметь две разные версии одного зачисления.
 */
export function renderSaleNotice(event: LotSoldEvent): string {
  const label = junkLabel(event.junk);
  const units = `${event.amount} ${pluralize(event.amount, label)}`;
  const commission = event.grossSec - event.netSec;
  const fee = commission > 0 ? ` Комиссия рынка — ${commission} SEC.` : '';
  const text = `💰 Контрабанда доставлена: лот «${units}» выкуплен. На счёт зачислено ${event.netSec} SEC.${fee}`;
  return text.length > NOTICE_MAX_CHARS ? `${text.slice(0, NOTICE_MAX_CHARS - 1)}…` : text;
}

/**
 * Склонение числительного для двух падежей, которых хватает на эти фразы:
 * «1 микросхема», «2 микросхемы», «5 микросхем».
 *
 * Формула русская, а не таблица исключений: `n % 10` и `n % 100` покрывают весь
 * диапазон размеров лота (1…1000) без единой специальной ветки.
 */
export function pluralize(count: number, forms: { one: string; few: string; many: string }): string {
  const abs = Math.abs(Math.trunc(count));
  const tens = abs % 100;
  const units = abs % 10;
  if (tens >= 11 && tens <= 14) return forms.many;
  if (units === 1) return forms.one;
  if (units >= 2 && units <= 4) return forms.few;
  return forms.many;
}
