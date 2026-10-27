import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/http/app.js';
import { createContext } from '../src/http/context.js';
import { testConfig } from './fixtures.js';

/**
 * Контракт «фронт → сервер» по ПУТЯМ запросов и ПОЛЯМ ответов (P3).
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
 *
 * Вторая ось того же контракта — поля (см. раздел в конце файла). Путь, который
 * существует, ещё не означает, что ответ несёт нужное поле: переименуй `heatPerNitrogen`
 * в сериализаторе, и все пять вызовов витрины вернут 200, а подсказка покажет
 * «undefined кВт-тепла». Проверки путей это не видят вообще.
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

/**
 * `app.get('/v1/x')` и `app.post<{ Params: ... }>('/v1/y/:id')` → список маршрутов.
 *
 * Каталог `routes/` — не единственное место, где регистрируется маршрут:
 * `/health`, `/v1/config` и обе стендовые страницы живут в самом `app.ts`.
 * Не прочти мы его, витрина, зовущая `/v1/config`, получила бы красный тест при
 * полностью работающем сервере — а такой тест хуже отсутствия теста.
 */
function collectServerRoutes(): RoutePattern[] {
  const routes: RoutePattern[] = [];
  const sources = [...readTsFiles(ROUTES_DIR), stripComments(readFileSync(join(here, '../src/http/app.ts'), 'utf8'))];
  for (const source of sources) {
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

/**
 * Исходник витрины без комментариев.
 *
 * Один источник для двух родов проверок: адреса, куда страница стучится, и правила,
 * по которым она считает. Комментарии вырезаются, иначе разговор о пути в объяснении
 * считался бы путём (см. stripComments), а упоминание старого бага в комментарии —
 * живым симптомом.
 */
function playSource(): string {
  return stripComments(readFileSync(join(here, '../src/http/play.html'), 'utf8'));
}

/**
 * Пути, которые отправляет витрина полигона (`server/src/http/play.html`).
 *
 * HTML-страница — такой же клиент контракта, как `frontend/src`, и её адреса
 * ломаются ровно так же: переименуй сервер маршрут, и витрина получит 404
 * с формулировкой «Маршрут не найден», которую никто не свяжет с правкой в
 * `routes/`. Проверяются только литералы первых двух аргументов `api(method, path)`:
 * склеенные хвосты (`'/v1/market/lots/' + id + '/cancel'`) даются как префикс и
 * требуют, чтобы за ним стоял хотя бы один зарегистрированный маршрут.
 */
function collectPlayPaths(): string[] {
  const source = playSource();
  const paths = new Set<string>();
  for (const match of source.matchAll(/\bapi\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'([^']*)'/g)) {
    const value = (match[2] ?? '').split('?')[0] ?? '';
    if (value.startsWith('/v1/')) paths.add(value);
  }
  return [...paths];
}

function coveredByServerRoute(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  if (path.endsWith('/')) {
    // Префикс склеенного URL: достаточно, что маршрут начинается этими сегментами.
    return serverRoutes.some(
      (route) =>
        route.segments.length >= segments.length &&
        segments.every((segment, index) => route.segments[index] === segment)
    );
  }
  return serverRoutes.some((route) => matches(route, segments));
}

const playPaths = collectPlayPaths();

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

describe('http/frontend-contract: витрина полигона (/play) ходит только в живые маршруты', () => {
  it('страница найдена и путей в ней достаточно, чтобы верить выводу', () => {
    // Пустой вход — тихий зелёный тест: регулярка могла разойтись со стилем вызовов.
    expect(playPaths.length, 'пути полигона').toBeGreaterThan(10);
  });

  it('каждый путь, который строит полигон, имеет маршрут на сервере', () => {
    const unmatched = playPaths.filter((path) => !coveredByServerRoute(path));
    expect(unmatched, `не зарегистрированы: ${unmatched.join(', ')}`).toEqual([]);
  });

  it('боевой вход VK подключён к витрине, а не только dev-login', () => {
    // Ради этого пункта и затеян файл: `play.html` годами звал только
    // `/v1/auth/dev-login`, и серверный `/v1/auth/vk/init-data` оставался
    // единственной непроверяемой петлёй входа. Исчезновение этого пути из
    // HTML — сигнал, что витрину откатили к отладочному входу.
    expect(playPaths).toContain('/v1/auth/vk/init-data');
    expect(playPaths).toContain('/v1/auth/dev-login');
    expect(serverRoutes.some((route) => route.raw === '/v1/auth/vk/init-data')).toBe(true);
  });

  it('генератор initData существует и закрыт тем же флагом, что dev-login', () => {
    expect(serverRoutes.some((route) => route.raw === '/v1/dev/vk/sign' && route.method === 'POST')).toBe(true);
  });

  it('режим входа витрина узнаёт у сервера, а не угадывает', () => {
    expect(playPaths).toContain('/v1/config');
  });

  it('отмена стройки ходит в живой маршрут, а не в выдуманный', () => {
    // Витрина склеивает хвост (`'/v1/workshop/build/' + jobId + '/cancel'`), а префикс
    // сам по себе существования маршрута не доказывает: без этой строки 404 на отмене
    // поймал бы только игрок, нажав кнопку.
    expect(serverRoutes.some((route) => route.raw === '/v1/workshop/build/:jobId/cancel')).toBe(true);
    expect(playPaths.some((path) => path.startsWith('/v1/workshop/build/'))).toBe(true);
  });

  it('срок из ответа сервера витрина вычитает из миллисекунд, а не из строки', () => {
    // Баг, заметный только игроку: `BuildJob.endsAt` — доменный `Date`, а через JSON
    // маршрута он приезжает строкой `"2026-10-26T09:36:41.342Z"`. Выражение
    // `job.endsAt - Date.now()` поэтому равно NaN, и журнал показывал
    // «начато: Грузовой дрон · NaNс» — то есть срок старта не видел никто.
    //
    // Типы здесь бессильны: страница не собирается и не типизирована (принцип 3 в её
    // шапке), а `fmtMs(NaN)` печатает «0с» вместо падения, так что молчаливый зелёный
    // гарантирован и на живом прогоне. Единственная защита — статическое правило
    // по исходнику, того же рода, что и проверка адресов выше.
    const offenders: string[] = [];
    for (const match of playSource().matchAll(/([A-Za-z0-9_.$[\]'"()]*)\s*-\s*Date\.now\(\)/g)) {
      const left = (match[1] ?? '').trim();
      // Разрешено ровно одно: левый операнд уже приведён к числу через getTime().
      if (!left.endsWith('.getTime()')) offenders.push(left || '<пусто>');
    }
    expect(offenders, `сырая дата участвует в вычитании: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('http/frontend-contract: боевой клиент (frontend/src) подключён к входу', () => {
  it('адаптер входа существует и зовёт боевой маршрут, а не только dev-login', () => {
    // Смысл пункта: три адаптера фронта (реклама, платежи, шеринг) ходят в сервер
    // с токеном. Пока `VkAuthManager` не появился, этот токен было неоткуда взять
    // — `/v1/auth/vk/init-data` оставался единственной петлёй входа, не
    // подключённой к фронтенду. Исчезновение пути отсюда = регрессия.
    expect(clientPaths).toContain('/v1/auth/vk/init-data');
    expect(clientPaths).toContain('/v1/config');
    expect(clientPaths).toContain('/v1/me');
  });

  it('фронт не выдумывает маршруты входа, которых нет на сервере', () => {
    // `/v1/auth/vk/sign` — генератор стенда (закрыт DEV_SIGNER_ENABLED): если
    // боевой клиент начнёт им пользоваться, на проде он получит 403 вместо входа.
    expect(clientPaths.some((path) => path.startsWith('/v1/dev/'))).toBe(false);
    expect(serverRoutes.some((route) => route.raw === '/v1/auth/vk/init-data' && route.method === 'POST')).toBe(true);
  });
});

// ─── Поля ответов: что витрина читает по имени ───────────────────────────────

/**
 * Переменные витрины и маршруты, откуда они пришли.
 *
 * Соответствие «глобальная переменница страницы → endpoint» существует только здесь,
 * хотя в самой витрине оно разбросано по разным местам: `S.snap` наполняется из
 * ЛЮБОГО ответа, где есть `{user, economy}` (см. `adoptView`), `S.blueprints` и
 * `S.cfg` — из своих вызовов, `S.clan` и `S.market` — из своих. Прочитать его
 * больше негде, а без него проверка поля невозможна: `S.snap.economy.warehouses`
 * — это про `/v1/economy`, и отвечать за него должен тот же маршрут.
 *
 * `S.draft` в списке нет намеренно: это локальная копия планировки, собранная
 * `syncDraftFromView`, а не ответ сервера. Требовать от сервера её полей — значит
 * требовать того, чего он никогда не отдавал.
 */
const PLAY_ROOTS: Record<string, string> = {
  cfg: '/v1/config',
  blueprints: '/v1/workshop/blueprints',
  snap: '/v1/economy',
  clan: '/v1/clan',
  market: '/v1/market'
};

/**
 * Чем цепочка вправе заканчиваться, не будучи полем ответа.
 *
 * Витрина пишет `S.cfg.pvp.attack.kinds.includes(item.kind)` и
 * `S.snap.user.id.slice(0, 8)`: `includes` и `slice` — методы оболочки, а не данные
 * сервера. Без этой поправки проверка требовала бы несуществующего поля в полностью
 * живом ответе, то есть горела бы на ровном месте — а такой тест хуже отсутствия
 * теста (см. шапку файла).
 */
const CONTAINER_TAILS = new Set([
  'at', 'charAt', 'concat', 'entries', 'every', 'filter', 'find', 'findIndex', 'flat', 'flatMap',
  'forEach', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'length', 'map', 'pop', 'push',
  'reduce', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'split', 'toFixed', 'toString',
  'trim', 'unshift', 'valueOf', 'values'
]);

/** Одна цепочка `S.<корень>.<поле>...` в исходнике витрины, очищенная от методов оболочки. */
interface FieldRead {
  root: string;
  /** Путь относительно корня: `economy.power.rows`. */
  path: string;
}

/** Литеральное обращение к полю ответа: `S.snap.economy.base` (включая хвост-метод). */
const FIELD_CHAIN_RE = /\bS\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+/g;

/**
 * Все поля, которые витрина называет по имени.
 *
 * Источник — только литеральные цепочки `S.<корень>.…`. Остальное витрина делает
 * через локальные переменные (`const eco = S.snap.economy`, `const wh = list.find(…)`),
 * где имя поля уже потеряно для любого разбора без анализа потока данных. Это
 * сознательное ограничение, а не претензия на полноту: переименование в `rows` или
 * `heatPerNitrogen` обязано ловиться именно по прямым обращениям — их пишут один раз,
 * в одном месте, и не вспоминают о них, когда правят сериализатор в другом.
 */
function collectPlayFieldReads(): FieldRead[] {
  const source = playSource();
  const reads: FieldRead[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(FIELD_CHAIN_RE)) {
    const parts = match[0].slice(2).split('.');
    const root = parts[0] ?? '';
    const segments = parts.slice(1);
    if (!(root in PLAY_ROOTS)) continue;
    while (segments.length > 0 && CONTAINER_TAILS.has(segments[segments.length - 1] ?? '')) {
      segments.pop();
    }
    if (segments.length === 0) continue;
    const path = segments.join('.');
    const id = `S.${root}.${path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    reads.push({ root, path });
  }
  return reads;
}

/**
 * Множество путей, реально присутствующих в сериализованном ответе.
 *
 * Обходим именно JSON, а не типы и не исходник маршрута: контракт — это то, что ушло
 * по проводам. Доменный `Date` через JSON становится строкой, поле со значением
 * `undefined` из объекта исчезает вовсе, а `viewOf` собирает витрину не там, где живёт
 * интерфейс `EconomyView`. Ни типы, ни регулярка по маршруту этого не видят.
 *
 * Массив прозрачен: витрина пишет `economy.inventory`, а не `economy.inventory[0]`,
 * поэтому элементы вносят свои пути под тем же префиксом.
 */
function collectResponsePaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectResponsePaths(item, prefix, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    collectResponsePaths(child, path, out);
  }
}

/** Спуск по пути внутри разобранного ответа; массивы не траверсируются (пути к константам их не содержат). */
function navigateResponse(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Один стенд на весь раздел: ответы витрины не зависят от порядка тестов, а
 * `buildApp` — не самая дешёвая операция в этом файле.
 *
 * Вход — `dev-login` на тестовом конфиге: именно им пользуется сама витрина, когда
 * открывает страницу вне WebView (см. блок «Вход в игру» в `play.html`). Брать для
 * снимка другой способ входа значило бы проверять поля, которые витрина в этом
 * режиме не получает.
 */
let standPromise: Promise<Map<string, unknown>> | null = null;
let standApp: { close(): Promise<void> } | null = null;

async function openPlayStand(): Promise<Map<string, unknown>> {
  const app = await buildApp(createContext(testConfig({ DEV_SIGNER_ENABLED: 'true' })));
  standApp = app;
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    payload: { socialId: 'contract-fields' }
  });
  expect(login.statusCode, login.body).toBe(200);
  const token = String((login.json() as { token?: string }).token);
  const views = new Map<string, unknown>();
  for (const [root, path] of Object.entries(PLAY_ROOTS)) {
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode, `${path} → ${response.statusCode}: ${response.body.slice(0, 160)}`).toBe(200);
    views.set(root, response.json());
  }
  return views;
}

function playStand(): Promise<Map<string, unknown>> {
  if (!standPromise) standPromise = openPlayStand();
  return standPromise;
}

afterAll(async () => {
  if (standApp) await standApp.close();
  standApp = null;
  standPromise = null;
});

const playReads = collectPlayFieldReads();

/**
 * Плоские объекты констант, а не словари игровых сущностей.
 *
 * `labels.materials`, `units`, `blueprints` и `structures` сюда не входят намеренно:
 * их ключи — идентификаторы материалов и чертежей, и витрина достаёт их вычисленным
 * ключом (`labels.materials[id]`, `units[code]`), а не по имени. Поимённое чтение
 * для словаря означало бы переписать каждый материал прямо в HTML — и устаревать
 * при каждом добавлении руды.
 */
const PLAY_CONSTANT_BLOCKS: readonly FieldRead[] = [{ root: 'blueprints', path: 'power' }];

describe('http/frontend-contract: витрина читает только те поля, которые сервер отдаёт', () => {
  it('полей названо достаточно, чтобы верить выводу', () => {
    // Пустой выборкой зелёный тест гарантирован заранее: регулярка могла разойтись
    // со стилем записи страницы. Проверяем объём по каждому корню, прежде чем
    // верить общему списку («пустой вход — тихий зелёный тест», см. начало файла).
    for (const root of Object.keys(PLAY_ROOTS)) {
      expect(playReads.filter((read) => read.root === root).length, `корень S.${root}`).toBeGreaterThan(0);
    }
    expect(playReads.length, 'все чтения витрины').toBeGreaterThan(20);
  });

  it('каждое поле, названное витриной, есть в сериализованном ответе', async () => {
    const views = await playStand();
    const paths = new Map<string, Set<string>>();
    for (const [root, view] of views) {
      const set = new Set<string>();
      collectResponsePaths(view, '', set);
      paths.set(root, set);
    }
    const missing = playReads.filter((read) => !paths.get(read.root)?.has(read.path));
    expect(
      missing,
      `витрина читает то, чего сервер не отдаёт: ${missing.map((read) => `S.${read.root}.${read.path}`).join(', ')}`
    ).toEqual([]);
  });

  it('константы каталога не едут впустую: каждая читается витриной', async () => {
    const views = await playStand();
    const unread: string[] = [];
    for (const block of PLAY_CONSTANT_BLOCKS) {
      const value = navigateResponse(views.get(block.root), block.path);
      expect(value, `S.${block.root}.${block.path} отсутствует в ответе`).toBeTypeOf('object');
      const readNames = new Set(
        playReads
          .filter((read) => read.root === block.root && read.path.startsWith(`${block.path}.`))
          .map((read) => read.path.slice(block.path.length + 1))
      );
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!readNames.has(key)) unread.push(`S.${block.root}.${block.path}.${key}`);
      }
    }
    // Обратная сторона той же drift-проблемы. Поле, которое никто не читает, никто
    // и не обновит: оно лежит в ответе, расходится с доменом и выглядит правдой
    // для следующего, кто будет читать маршрут, а не витрину.
    expect(unread, `сервер отдаёт, а витрина не читает: ${unread.join(', ')}`).toEqual([]);
  });
});
// ─── Геометрия списков: столбик, а не решётка ────────────────────────────────

/**
 * Одно правило CSS из `<style>` витрины: селектор → тело объявления.
 *
 * Разбор намеренно плоский — без вложенных блоков и `@media`: все проверяемые
 * селекторы простые, и появление у них вложенности само по себе было бы сменой
 * подхода, которую стоит увидеть красным тестом, а не тихо проскочить. Пустая
 * строка в ответе означает «правило не найдено», и каждый тест проверяет это
 * отдельно: зелёный тест на пустой выборке вреден здесь ровно так же, как и в
 * проверке путей («пустой вход — тихий зелёный тест», см. шапку файла).
 */
function cssRule(source: string, selector: string): string {
  const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const flat = css.replace(/\s+/g, ' ');
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return flat.match(new RegExp('(?:^|[;{}])\\s*' + esc + '\\s*\\{([^}]*)\\}'))?.[1]?.trim() ?? '';
}

const playCss = playSource();

describe('http/frontend-contract: списки витрины читаются столбиком, а не решёткой', () => {
  it('ярлыки разделов идут одной колонкой сверху вниз', () => {
    // Порядок ярлыков объявлен массивом TABS, и решётка с переносом его разрушала:
    // десять ярлыков складывались в два-три этажа, и то, что игрок прочитал бы
    // «сверху вниз по TABS», рассыпалось зигзагом. Возврат к `flex-wrap` — не вопрос
    // вкуса, а потерянный порядок, объявленный на другом конце файла.
    const tabs = cssRule(playCss, '#tabs');
    expect(tabs, 'правило #tabs в <style>').not.toBe('');
    expect(tabs).toContain('flex-direction: column');
    expect(tabs).not.toContain('flex-wrap');
    expect(tabs).not.toContain('grid-template');
  });

  it('иконки того, что строится, идут той же колонкой', () => {
    // Сетка `repeat(auto-fill, minmax(58px, 1fr))` вытягивала каждый ряд по самому
    // высокому соседу: длинное имя («Жидкий азот») ломалось на две строки и утаскивало
    // за собой высоту всех соседей, а порядок, который собрали рендеры (FAMILY_ORDER в
    // энергосети, порядок чертежей в цехе), читался по колонкам влево-вправо.
    const grid = cssRule(playCss, '.icoGrid');
    expect(grid, 'правило .icoGrid в <style>').not.toBe('');
    expect(grid).toContain('flex-direction: column');
    expect(grid).not.toContain('grid-template');
  });

  it('сам ярлык — строка «значок │ название │ бейдж» на всю ширину колонки', () => {
    // Колонка контейнера без поворота содержимого дала бы вертикальную стопку внутри
    // каждой кнопки — ровно то, что было до правки. Проверяется пара: направление
    // ряда и растяжение на всю ширину, иначе строка повиснет узким обрывком слева.
    for (const selector of ['.tab', '.ico']) {
      const rule = cssRule(playCss, selector);
      expect(rule, `правило ${selector} в <style>`).not.toBe('');
      expect(rule).toContain('flex-direction: row');
      expect(rule).toContain('width: 100%');
    }
  });

  it('бейдж замыкает свою строку, а не висит над соседней', () => {
    // `position: absolute; right: -4px` был рассчитан на плотную сетку, где у ярлыка
    // есть свободный угол. В колонке этот угол — уже соседняя строка, и счётчик «0/2»
    // повисал бы между разделами. `margin-left: auto` стоит ровно по правому краю
    // своей строки и не влияет на соседей.
    const rule = cssRule(playCss, '.tab .badge, .ico .cnt');
    expect(rule, 'правило бейджа в <style>').not.toBe('');
    expect(rule).not.toContain('position: absolute');
    expect(rule).toContain('margin-left: auto');
  });
});




