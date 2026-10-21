/**
 * `npm run vk:doctor` — диагностика подписи ВКонтакте и транспорта пушей.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОЦЕСС. Подпись initData — единственное место в сервере, где
 * ошибка конфигурации выглядит как «игрок не может войти», и отличить её от бага кода
 * по логам почти невозможно: секрет скопирован с пробелом, приложение не включено,
 * фронт присылает старую схему подписи вместо новой. Здесь используется ТОТ ЖЕ код,
 * что в проде (`modules/auth/vk.signature.ts`, `modules/notification/vk.push.ts`),
 * поэтому доктор показывает правду, а не вторую реализацию формулы, которая разъедется
 * с первой в тот момент, когда понадобится.
 *
 * УПОТРЕБЛЕНИЕ:
 *   npm run vk:doctor                       — конфиг + три круговые подписи
 *   npm run vk:doctor -- "<initData>"       — разбор реальной строки запуска
 *   npm run vk:doctor -- --file <путь>      — то же, но строка из файла (в ней `&`
 *                                             и `=`, которые командная строка Windows
 *                                             портит; оператор сохраняет её из логов)
 *   npm run vk:doctor -- --push <user_id>   — отправить пробный пуш (трогает сеть)
 *
 * Разбор реальной initData покрывает и то, что нельзя увидеть в логах входа:
 * в каком поле пришла подпись (`sign` или алиас `sig`), какой ФОРМЫ она
 * (hex64 = mini_app, base64url = launch_params — диагноз, не зависящий от
 * секрета), каким проходом она сошлась (сырые байты или раскрытые значения,
 * `hash` внутри строки проверки или снаружи), есть ли в строке поле времени
 * (без него replay-окно бесполезно) и какая реферальная метка там лежит
 * (`hash` площадка не подписывает, поэтому источник указывается явно).
 *
 * При отказе доктор печатает ВСЕ перебранные комбинации (`raw|decoded` ×
 * `nohash|hash` × две схемы) с их именами параметров — ровно то, что сервер
 * пишет в `auth_vk_rejected`. Это и есть ответ на вопрос «не тот секрет или
 * незнакомая схема», единственный вопрос первого живого входа.
 *
 * Круговые подписи: initData (вход игрока), событие площадки (платёж), рекламный
 * постбэк (награда). Все три идут через прод-код, поэтому расхождение видно здесь,
 * а не в логах потерянных наград.
 *
 * Выход: 0 — претензий нет; 1 — есть хотя бы одна причина, по которой игрок не войдёт,
 * не получит уведомление, оплату или награду за рекламу.
 */
import { readFileSync } from 'node:fs';

import { isVkConfigured, loadConfig } from '../src/config/env.js';
import { parseVkAdPostback, toVkParams } from '../src/modules/ads/postback.js';
import { verifyVkEvent, signVkEvent } from '../src/modules/payment/provider.vk.js';
import {
  VkSignatureScheme,
  classifyVkSignShape,
  diagnoseVkInitData,
  formatVkPass,
  inspectVkSignatures,
  parseVkParams,
  signatureOf,
  signVkLaunchParams,
  signVkMiniApp,
  verifyVkSignature,
  verifyVkInitDataParams,
  type VkParams
} from '../src/modules/auth/vk.signature.js';
import { extractReferralClaim } from '../src/modules/auth/vk.adapter.js';
import { renderSaleNotice, type LotSoldEvent } from '../src/modules/notification/notice.types.js';
import { isVkPushConfigured, sendVkPush, type VkPushSettings } from '../src/modules/notification/vk.push.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;

function ok(label: string, detail?: string): void {
  process.stdout.write(`${GREEN}  ✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}\n`);
}

function bad(label: string, detail?: string): void {
  failures += 1;
  process.stdout.write(`${RED}  ✗${RESET} ${label}${detail ? `: ${detail}` : ''}\n`);
}

function warn(label: string, detail?: string): void {
  process.stdout.write(`${YELLOW}  !${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

const args = process.argv.slice(2);

/** Значение флага с аргументом (`--push <id>`, `--file <path>`) либо null. */
function flagValue(name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

const pushUserId = flagValue('--push');
const initDataFile = flagValue('--file');

/**
 * Живая initData из файла.
 *
 * Флаг существует, потому что тащить эту строку аргументом командной строки —
 * гарантированная порча: в ней `&`, `=`, `+` и `/`, а в Windows `&` ещё и
 * разделитель команд. Оператор сохраняет строку из логов или из URL iframe'а в
 * файл и скармливает доктору как есть.
 */
let initDataFromFile: string | null = null;
if (initDataFile !== null) {
  try {
    initDataFromFile = readFileSync(initDataFile, 'utf8').trim();
  } catch (error) {
    bad('--file не читается', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const taken = new Set<string>(['--push', '--file']);
if (pushUserId) taken.add(pushUserId);
if (initDataFile) taken.add(initDataFile);
const initDataArg = initDataFromFile ?? args.find((arg) => !arg.startsWith('--') && !taken.has(arg)) ?? null;

// ─── 1. Конфиг: ровно тот же путь валидации, что у продакшна ─────────────────
section('1. Конфигурация VK');
let config;
try {
  config = loadConfig();
} catch (error) {
  bad('loadConfig отклонил окружение', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (!config) process.exit(1);

if (config.vk.appId > 0) ok('VK_APP_ID', String(config.vk.appId));
else bad('VK_APP_ID не задан', 'авторизация вернёт VK_NOT_CONFIGURED на любой строке запуска');

if (config.vk.secretKey.length > 0) {
  ok('VK_SECRET_KEY', `${config.vk.secretKey.length} симв.`);
  // Типичная порча при копировании из панели администратора: пробелы по краям.
  if (config.vk.secretKey !== config.vk.secretKey.trim()) {
    bad('VK_SECRET_KEY содержит обрамляющие пробелы', 'подпись не совпадёт ни на одной схеме');
  }
} else {
  bad('VK_SECRET_KEY не задан', 'без него невозможно проверить ни одну подпись');
}

ok('isVkConfigured', String(isVkConfigured(config)));
warn('PAYMENTS_ENABLED', config.economy.limits.purchases.enabled ? 'включён' : 'выключен');

// ─── 2. Подпись: реальная строка запуска либо круговая проверка ───────────────
section('2. Подпись initData');
const sample: VkParams = initDataArg
  ? parseVkParams(initDataArg)
  : syntheticParams(config.vk.appId, config.vk.secretKey);

if (initDataArg) {
  const keys = Object.keys(sample);
  ok('разобрано параметров', String(keys.length));
  if (keys.length === 0) bad('в строке не разобралось ничего', 'передана не initData и не query-строка');
  const sign = signatureOf(sample);
  if (!sign) bad('нет поля подписи', 'ни `sign`, ни `sig` — площадка прислала неподписанные параметры');
  else ok('поле подписи', sign.key);
  // Реферал проверяется здесь же: метка приходит в неподписанном `hash`, и
  // «друга не засчитали» разбирается по этой строке, а не по логам сервера.
  const referral = extractReferralClaim(sample);
  if (referral) {
    ok(
      'реферальная метка',
      `${referral.raw} · источник ${referral.source} · ` +
        (referral.inviterId ? `id пригласившего ${referral.inviterId}` : 'не наша (награды не будет)')
    );
  }
} else {
  warn('initData не передан', 'проверяю круговую подпись синтетическим набором параметров');
}

const checks = inspectVkSignatures(sample, { appId: config.vk.appId, secretKey: config.vk.secretKey });
for (const check of checks) {
  const verdict = check.matched ? `${GREEN}совпала${RESET}` : `${DIM}не совпала${RESET}`;
  process.stdout.write(`  · ${check.scheme.padEnd(14)} ${verdict}${check.signKey ? ` ${DIM}(${check.signKey})${RESET}` : ''}\n`);
  const line = check.checkString.length > 120 ? `${check.checkString.slice(0, 120)}…` : check.checkString;
  process.stdout.write(`    ${DIM}check_string:${RESET} ${line}\n`);
  process.stdout.write(`    ${DIM}expected:${RESET} ${check.expectedSign}\n`);
}

// Форма подписи — диагноз, не зависящий от секрета. Она же пишет в лог отказа
// (`auth_vk_rejected`) сервер, поэтому доктор и лог обязаны говорить одним
// языком: hex64 = mini_app, base64url = launch_params, всё остальное — третья,
// незнакомая нам схема, и вход по ней сегодня невозможен ни при каком секрете.
if (initDataArg) {
  const shape = classifyVkSignShape(signatureOf(sample)?.value ?? null);
  if (shape === 'unknown') {
    bad(
      'форма подписи не распознана',
      'не hex64 (mini_app) и не base64url43 (launch_params): площадка прислала то, что верификатор не умеет проверять'
    );
  } else {
    ok('форма подписи', `${shape} · ожидание схемы ${shape}`);
  }
  if (signatureOf(sample)?.value && shape === 'launch_params' && sample['vk_app_id'] === undefined) {
    warn('launch_params без vk_app_id', 'старая схема пришла без идентификатора приложения: вход отвергнется по структуре');
  }
}

// Тот же перебор, что в проде: (сырые байты → раскрытые) × (`hash` снаружи
// строки проверки → внутри). Для круговой (синтетической) проверки строки нет —
// есть только набор полей.
const verified = initDataArg
  ? verifyVkInitDataParams(initDataArg, { appId: config.vk.appId, secretKey: config.vk.secretKey })
  : (() => {
      const check = verifyVkSignature(sample, { appId: config.vk.appId, secretKey: config.vk.secretKey });
      return check ? { params: sample, check, source: 'synthetic' as const, hashIncluded: false } : null;
    })();
if (verified) {
  const hashNote = verified.hashIncluded ? ' · hash внутри строки проверки' : '';
  ok('верификация', `схема ${verified.check.scheme} · проход ${verified.source}${hashNote}`);
  if (verified.hashIncluded) {
    warn(
      'площадка подписала `hash`',
      'форма вне документации Mini Apps: верификатор её принимает, но по логам `auth_vk` стоит свериться с актуальным документом ВК'
    );
  }
} else if (initDataArg) {
  bad('ни одна схема не распознала подпись', 'секрет не тот, что подписывал строку, либо параметры изменены в пути');
  // Что именно перебиралось — единственное, что отличает «не тот секрет» от
  // «пришла третья схема», и на отказе это дороже, чем на успехе.
  const diagnosis = diagnoseVkInitData(initDataArg, { appId: config.vk.appId, secretKey: config.vk.secretKey });
  process.stdout.write(`    ${DIM}parameters:${RESET} ${diagnosis.paramKeys.join(', ')}${diagnosis.paramCount > diagnosis.paramKeys.length ? ' …' : ''}\n`);
  for (const line of diagnosis.passes.map(formatVkPass)) {
    process.stdout.write(`    ${DIM}pass:${RESET} ${line}\n`);
  }
} else {
  bad('круговая подпись не сошлась', 'это не конфиг: сломан сам код подписи, вход сломается у всех');
}

if (initDataArg && verified) {
  const tsRaw = ['vk_ts', 'ts', 'auth_date', 'timestamp'].map((key) => sample[key]).find((v) => !!v) ?? null;
  const ts = tsRaw ? Number(tsRaw) : Number.NaN;
  if (!Number.isFinite(ts) || ts <= 0) {
    bad(
      'нет поля времени (vk_ts / ts / auth_date / timestamp)',
      'replay-окно VK_INIT_DATA_SOURCE_TTL_SECONDS не к чему применить: строку можно унести и использовать повторно'
    );
  } else {
    const ageSec = Math.floor(Date.now() / 1000) - ts;
    if (ageSec > config.vk.initDataSourceTtlSec) {
      warn(
        'устаревшая строка запуска',
        `${ageSec}с назад при TTL ${config.vk.initDataSourceTtlSec}с: подпись верна, но вход по ней запрещён`
      );
    } else {
      ok('свежесть', `${ageSec}с назад при TTL ${config.vk.initDataSourceTtlSec}с`);
    }
  }
  if (verified.check.scheme === VkSignatureScheme.LAUNCH_PARAMS) {
    warn(
      'приложена СТАРАЯ схема (launch_params)',
      'современные Mini Apps подписывают по mini_app — проверь, что фронт не отдаёт старый bridge'
    );
  }
}

// ─── 2а. Стендный генератор initData ─────────────────────────────────────────
// Боевой вход непроверяем без координат площадки, и для локального стенда они
// есть не у каждого. Доктор обязан сказать, доступен ли POST /v1/dev/vk/sign —
// им же пользуется smoke-прогон входа.
if (config.devSignerEnabled) {
  ok(
    'dev-генератор initData',
    'POST /v1/dev/vk/sign · curl -s -X POST localhost:3000/v1/dev/vk/sign -H "content-type: application/json" -d \'{"socialId":"1"}\''
  );
} else {
  warn('dev-генератор initData выключен', 'DEV_SIGNER_ENABLED=false: локальный вход проверяется только живой initData');
}

// ─── 2б. Событие площадки: та же круговая проверка подписи ───────────────────
// `/callbacks/vk/events` проверяет подпись по `VK_EVENT_SERVICE_ID` (разрешённая
// схема из payment/provider.vk.ts). Круговая проверка здесь повторяет трюк с
// initData: если код подписи сломан в одном месте, врач сгодится и для второго.
if (config.vk.secretKey.length > 0) {
  const eventRaw = JSON.stringify({
    event_id: 'doctor',
    type: 'onAppPayment',
    api_id: config.vk.appId,
    sent_at: Math.floor(Date.now() / 1000),
    reference: { item: 'doctor_item' }
  });
  const eventSignature = signVkEvent(eventRaw, config.vk.secretKey, config.vkEvents.serviceId);
  const eventCheck = verifyVkEvent(eventRaw, eventSignature, {
    secretKey: config.vk.secretKey,
    serviceId: config.vkEvents.serviceId,
    sentAt: Math.floor(Date.now() / 1000),
    now: new Date(),
    maxAgeSec: config.vkEvents.maxAgeSec
  });
  if (eventCheck.ok) ok('vk:events подпись', `service_id=${config.vkEvents.serviceId}`);
  else bad('vk:events круговая подпись не сошлась', `reason=${eventCheck.reason}`);
} else {
  warn('событие площадки не проверяю', 'VK_SECRET_KEY пуст — см. выше');
}

// ─── 2в. Рекламный постбэк: круг по тому же пути, что пройдёт площадка ────────
// `/callbacks/vk/ads` — единственное место, где просмотр ролика становится
// наградой, и подпись у него схема mini_app (тот же прод-код, что у initData).
// Круг повторяет ОБА транспорта маршрута (query для GET, тело для POST) и ОБА
// формата постбэка: с `reward_id` площадки и без него — мост 3.0.2 не передаёт
// приложению свой идентификатор, поэтому второй формат основной. Расхождение
// здесь молча стоит игрокам наград, а замечать его дешевле ADS_POSTBACK_READY.
if (config.vk.secretKey.length > 0) {
  const shapes: Array<{ label: string; params: VkParams }> = [
    { label: 'с reward_id', params: { user_id: 'doctor', reward_id: 'platform-reward-1' } },
    { label: 'без reward_id', params: { user_id: 'doctor' } }
  ];
  for (const shape of shapes) {
    const signed: VkParams = {
      ...shape.params,
      sign: signVkMiniApp(shape.params, config.vk.appId, config.vk.secretKey)
    };
    const transports: Array<[string, VkParams]> = [
      ['query', parseVkParams(new URLSearchParams(signed).toString())],
      ['body', toVkParams(signed)]
    ];
    for (const [name, inbound] of transports) {
      const verified = verifyVkSignature(inbound, {
        appId: config.vk.appId,
        secretKey: config.vk.secretKey
      });
      const parsed = verified ? parseVkAdPostback(inbound) : null;
      const label = `vk:ads постбэк ${shape.label} (${name})`;
      if (!verified) {
        bad(label, 'круговая подпись mini_app не сошлась — награду не получит никто');
      } else if (
        !parsed ||
        parsed.userId !== shape.params.user_id ||
        parsed.rewardId !== (shape.params.reward_id ?? null)
      ) {
        bad(label, `user_id/reward_id потерялись в транспорте: ${JSON.stringify(parsed)}`);
      } else {
        ok(label, `схема=${verified.scheme}`);
      }
    }
  }
  if (config.economy.limits.ads.enabled && !config.adsPostbackReady) {
    warn(
      'реклама включена без подтверждения постбэка',
      'ADS_POSTBACK_READY=false: в production старт не состоится; до включения сверь в кабинете URL /callbacks/vk/ads, имена user_id/reward_id и САМО наличие reward_id — от него зависит, работает ли память реплея'
    );
  }

  // Память исполненных reward_id — единственная защита от повторной доставки,
  // доступная до первого живого постбэка. Доктор показывает её глубину: окно
  // в пару минут превратило бы защиту в декорацию, и узнать это дешевле здесь,
  // чем по пропаже наград в проде.
  const replayWindowSec = config.economy.limits.ads.replayWindowMs / 1000;
  if (replayWindowSec >= 3600) {
    ok(
      'vk:ads память реплея',
      `ADS_REPLAY_WINDOW_SEC=${replayWindowSec}: исполненные reward_id помнятся ${Math.round(replayWindowSec / 3600)} ч`
    );
  } else {
    warn(
      'vk:ads память реплея мелкая',
      `окно ${replayWindowSec} с: повтор, прилетевший позже, накормит следующий слот игрока`
    );
  }
} else {
  warn('рекламный постбэк не проверяю', 'VK_SECRET_KEY пуст — см. выше');
}

// ─── 3. Транспорт уведомлений ────────────────────────────────────────────────
section('3. VK Push');
const push: VkPushSettings = {
  appId: config.vk.appId,
  secretKey: config.vk.secretKey,
  endpoint: config.notifications.push.endpoint,
  apiVersion: config.notifications.push.apiVersion,
  timeoutMs: config.notifications.push.timeoutMs
};

if (!config.notifications.push.enabled) {
  warn('VK_PUSH_ENABLED=false', 'очередь принимает факты продаж и молча отказывает — пушей нет');
} else if (!isVkPushConfigured(push)) {
  bad('VK_PUSH_ENABLED=true при неполных ключах', 'каждая продажа вернёт 6.13.2/113 и осядет в логе как notice_rejected');
} else {
  ok('VK_PUSH_ENABLED', `${push.endpoint} · v${push.apiVersion} · таймаут ${push.timeoutMs}мс`);
  const demo: LotSoldEvent = {
    lotId: 'doctor',
    sellerId: 'doctor',
    sellerPlatform: 'vk',
    sellerSocialId: pushUserId ?? '1',
    buyerId: null,
    junk: 'engines',
    amount: 3,
    grossSec: 15_000,
    netSec: 14_250,
    at: new Date()
  };
  const text = renderSaleNotice(demo);
  ok('шаблон текста', `«${text}» (${text.length} симв.)`);

  if (pushUserId) {
    const result = await sendVkPush(push, pushUserId, text, {
      fetch: (url, init) =>
        fetch(url, init).then((response) => ({
          status: response.status,
          json: () => response.json() as Promise<unknown>
        }))
    });
    if (result.kind === 'sent') ok('пробный пуш принят площадкой', `user_id=${pushUserId}`);
    else bad('пробный пуш не принят', `${result.kind} · code=${result.code ?? '—'} · ${result.message}`);
  } else {
    warn(
      'пробная отправка не делалась',
      'npm run vk:doctor -- --push <user_id>: трогает сеть и требует права на метод у приложения'
    );
  }
}

section('Итог');
if (failures === 0) {
  process.stdout.write(`${GREEN}Претензий нет.${RESET}\n`);
  process.exit(0);
}
process.stdout.write(`${RED}Причин не работать: ${failures}.${RESET}\n`);
process.exit(1);

/**
 * Синтетический набор параметров для круговой проверки подписи, когда живая initData
 * не передана. Секрет пуст — подписывать нечем, и тогда возвращается launch-набор:
 * проверка всё равно прогонит обе ветки кода и честно упадёт на `bad(...)`.
 */
function syntheticParams(appId: number, secretKey: string): VkParams {
  const ts = String(Math.floor(Date.now() / 1000));
  const miniApp: VkParams = {
    is_app_user: '1',
    listener: '0',
    mid: '123456789',
    platform: 'vk',
    realm: 'vk.com',
    session_hash: 'abC123-_9',
    sign: '',
    ts,
    user_prefix: 'user_',
    vk_app_id: String(appId),
    viewer_id: '123456789'
  };
  miniApp['sign'] = signVkMiniApp(miniApp, appId, secretKey);
  if (secretKey.length > 0) return miniApp;

  const launch: VkParams = {
    vk_anonymous_id: '0',
    vk_is_secure: '0',
    vk_protocol: 'https',
    vk_ts: ts,
    vk_user_id: '123456789',
    sign: ''
  };
  launch['sign'] = signVkLaunchParams(launch, secretKey);
  return launch;
}
