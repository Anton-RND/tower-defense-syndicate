import { AppError, ErrorCodes } from '../../lib/errors.js';
import type { SocialIdentity } from './vk.adapter.js';
import { parseVkParams } from './vk.signature.js';

/**
 * Telegram Web Apps — Шаг 2 плана (см. docs/ARCHITECTURE.md).
 *
 * Схема подписи там другая и уже хорошо известна:
 *   secret = HMAC_SHA256(key = 'WebAppData', data = BOT_TOKEN)
 *   check_string = join(sorted(`key=value`), '\n')          ← перенос строки, не '&'
 *   hash = HMAC_SHA256(key = secret, data = check_string)   → hex
 *   + обязательная проверка auth_date и бонусная — hostname
 * Реализуется отдельным адаптером `verifyTgInitData` с теми же выходными SocialIdentity,
 * чтобы остальной бэкенд (стор, экономика, PvP) ничего не менял.
 */
export function verifyTgInitData(_rawInitData: string): SocialIdentity {
  throw new AppError(
    ErrorCodes.PLATFORM_NOT_SUPPORTED,
    501,
    'Авторизация Telegram включается на Шаге 2. Пока доступен только ВКонтакте.',
    { platform: 'tg', step: 2 }
  );
}

/** Примерная структура реферальной просьбы об энергии (п.2.3): t.me/bot?start=give_energy_<userId> */
export function parseTgDeepLinkValue(value: string): { action: string; targetId: string } | null {
  const match = /^([a-z_]+)_([0-9a-f]{8,})$/i.exec(value.trim());
  if (!match) return null;
  const action = match[1];
  const targetId = match[2];
  if (!action || !targetId) return null;
  return { action, targetId };
}

/** Утилита для генерации ссылки-просьбы (используется клиентом через Bot API / VK Share). */
export function buildTgGiveEnergyLink(botUsername: string, userId: string): string {
  const name = botUsername.replace(/^@/, '');
  return `https://t.me/${name}?start=give_energy_${userId}`;
}

/** Экспортировано ради тестов парсинга deep link'ов на Шаге 2. */
export const TG_INIT_DATA_PARSER = parseVkParams;
