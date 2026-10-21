import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Контракт «фронт → сервер» по ПУТЯМ запросов (P3).
 *
 * Зачем, если есть типы. `frontend/src/vk/VkPaymentManager.ts` обращался к
 * `/v1/payments/orders`, а сервер знает только `/v1/shop/orders`: маршрут не
 * существовал, и любой платёж умирал на шаге 1 с текстом «Заказ не создан» —
 * формулировкой, которая указывает на отказ домена, а не на опечатку в URL.
 * Ни один автотест это не поймал, и вот почему:
 *
 *  - типы не видят строк: путь — `string`, а не литерал, поэтому `tsc` зелёный;
 *  - `frontend` не входит в workspaces, и даже его собственная компиляция
 *    запускается только ручным `npm run typecheck:frontend`;
 *  - доменных тестов у фронта нет, а смоук ходит в сервер напрямую, минуя клиентский код.
 *
 * Отсюда решение: сверять адреса statically — прочитать исходники обеих сторон и
 * убедиться, что каждый путь, который фронт способен отправить, зарегистрирован на
 * сервере. Это не проверка поведения, а проверка адреса, и именно она здесь дорогая:
 * ошибка в адресе стоит игроку платежа, а не лишних 200 мс.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(here, '../src/http/routes');
const FRONTEND_DIR = join(here, '../../frontend/src');

interface RoutePattern {
  method: string;
  /** Сегменты маршрута Fastify: `:id` — параметр, остальное — литерал. */
  segments: string[];
  raw: string;
}

function readTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(stripComments(readFileSync(path, 'utf8')));
  }
  return out;
}

/**
 * Вырезание комментариев перед сканированием.
 *
 * Без этого тест врёт в обе стороны: закомментированный `app.get('/v1/x')` считался бы
 * зарегистрированным маршрутом, а упоминание старого пути в объяснении («не
 * `/v1/payments/orders`, а `/v1/shop/orders`») считалось бы тем, куда фронт реально
 * стучится. Разговор о пути — не путь.
 *
 * Реализация намеренно наивная (блочные и строчные комментарии, без учёта `//` внутри
 * строк): единственные строки с `//` в этих файлах — сами URL, и они начинаются с `/v1/`,
 * поэтому обрезка строки по `//` их не порождает. Усложнять до полноценного лексера
 * смысла нет: цена ошибки здесь — красный тест на ровном месте, а не зелёный врал.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `app.get('/v1/x')` и `app.post<{ Params: ... }>('/v1/y/:id')` → список маршрутов. */
function collectServerRoutes(): RoutePattern[] {
  const routes: RoutePattern[] = [];
  for (const source of readTsFiles(ROUTES_DIR)) {
    for (const match of source.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
      const raw = match[2] ?? '';
      routes.push({ method: (match[1] ?? '').toUpperCase(), segments: raw.split('/').filter(Boolean), raw });
    }
  }
  return routes;
}

/**
 * Пути, которые способен построить фронт. Два источника, оба намеренно простые:
 *
 *  A. любой строковый литерал с `/v1/` (включая описание маршрута в документации:
 *     `<id>` и `${...}` нормализуются в параметрический сегмент);
 *  B. производные от значения `basePath` по умолчанию — ровно те три формы, которые
 *     собирает `VkPaymentManager`: список заказов, один заказ и квитанция к заказу.
 */
function collectClientPaths(sources: string[]): string[] {
  const paths = new Set<string>();

  for (const source of sources) {
    for (const match of source.matchAll(/['"`]([^'"`]*\/v1\/[^'"`]*)['"`]/g)) {
      const value = (match[1] ?? '')
        .replace(/<[^>]+>/g, ':param')
        .replace(/\$\{[^}]+\}/g, ':param');
      if (value.startsWith('/v1/')) paths.add(value.replace(/\/+$/, ''));
    }
  }

  for (const source of sources) {
    for (const match of source.matchAll(/basePath\s*\?\?\s*'([^']+)'/g)) {
      const base = (match[1] ?? '').replace(/\/+$/, '');
      if (!base.startsWith('/v1/')) continue;
      paths.add(base);
      paths.add(`${base}/:param`);
      paths.add(`${base}/:param/receipt`);
    }
  }

  return [...paths];
}

function matches(route: RoutePattern, clientSegments: string[]): boolean {
  if (route.segments.length !== clientSegments.length) return false;
  return route.segments.every((segment, index) => segment.startsWith(':') || segment === clientSegments[index]);
}

const serverRoutes = collectServerRoutes();
const clientPaths = collectClientPaths(readTsFiles(FRONTEND_DIR));

describe('http/frontend-contract: пути фронта зарегистрированы на сервере', () => {
  it('обе стороны действительно найдены', () => {
    // Пустой вход — тихий зелёный тест. Проверяем объём, прежде чем верить выводу.
    expect(serverRoutes.length, 'маршруты сервера').toBeGreaterThan(20);
    expect(clientPaths.length, 'пути фронта').toBeGreaterThan(0);
  });

  it('каждый путь, который строит фронт, имеет маршрут на сервере', () => {
    const unmatched = clientPaths.filter((path) => {
      const segments = path.split('/').filter(Boolean);
      return !serverRoutes.some((route) => matches(route, segments));
    });
    expect(unmatched, `не зарегистрированы: ${unmatched.join(', ')}`).toEqual([]);
  });

  it('заказ оплачивается в `/v1/shop/orders`, а не в несуществующем `/v1/payments/*`', () => {
    // Отдельная строчка на конкретную прошлую ошибку: общий тест выше упал бы и при
    // переименовании серверного маршрута, а здесь падение укажет именно на префикс.
    expect(clientPaths).toContain('/v1/shop/orders');
    expect(clientPaths.some((path) => path.startsWith('/v1/payments'))).toBe(false);
    // Маршрут статуса одного заказа обязан существовать: на нём висит опрос
    // «оплата обрабатывается», и без него фронт крутил бы 404 до конца таймаута.
    expect(serverRoutes.some((route) => route.raw === '/v1/shop/orders/:orderId')).toBe(true);
  });

  it('реклама открывается и бросается через /v1/ads/* и никогда не климает сама', () => {
    // VkAdsManager обязан стучаться ровно в эти маршруты: слот открывается до
    // ролика, освобождается при отказе, а витрина кормит UI состоянием крана.
    expect(clientPaths).toContain('/v1/ads/session');
    expect(clientPaths).toContain('/v1/ads/abandon');
    expect(clientPaths).toContain('/v1/ads/offers');
    // ГЛАВНОЕ: награду выдаёт постбэк площадки, а не просьба клиента. /claim
    // закрыт DEV_SIGNER_ENABLED и в production его нет — появление этого пути
    // во фронте означает, что кто-то снова сделал из рекламы принтер энергии.
    expect(clientPaths.some((path) => path.startsWith('/v1/ads/claim'))).toBe(false);
  });
});
