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
 *   npm run vk:doctor                       — конфиг + круговая подпись
 *   npm run vk:doctor -- "<initData>"       — разбор реальной строки запуска
 *   npm run vk:doctor -- --push <user_id>   — отправить пробный пуш (трогает сеть)
 *
 * Выход: 0 — претензий нет; 1 — есть хотя бы одна причина, по которой игрок не войдёт
 * или не получит уведомление.
 */
import { isVkConfigured, loadConfig } from '../src/config/env.js';
import {
  VkSignatureScheme,
  inspectVkSignatures,
  parseVkParams,
  signVkLaunchParams,
  signVkMiniApp,
  verifyVkSignature,
  type VkParams
} from '../src/modules/auth/vk.signature.js';
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
const pushIndex = args.indexOf('--push');
const pushUserId = pushIndex === -1 ? null : (args[pushIndex + 1] ?? null);
const initDataArg =
  args.find((arg) => !arg.startsWith('--') && arg !== pushUserId) ?? null;

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
  if (!sample['sign']) bad('нет поля sign', 'площадка прислала неподписанные параметры — вход запрещён');
} else {
  warn('initData не передан', 'проверяю круговую подпись синтетическим набором параметров');
}

const checks = inspectVkSignatures(sample, { appId: config.vk.appId, secretKey: config.vk.secretKey });
for (const check of checks) {
  const verdict = check.matched ? `${GREEN}совпала${RESET}` : `${DIM}не совпала${RESET}`;
  process.stdout.write(`  · ${check.scheme.padEnd(14)} ${verdict}\n`);
  const line = check.checkString.length > 120 ? `${check.checkString.slice(0, 120)}…` : check.checkString;
  process.stdout.write(`    ${DIM}check_string:${RESET} ${line}\n`);
  process.stdout.write(`    ${DIM}expected:${RESET} ${check.expectedSign}\n`);
}

const verified = verifyVkSignature(sample, { appId: config.vk.appId, secretKey: config.vk.secretKey });
if (verified) ok('verifyVkSignature', `схема ${verified.scheme}`);
else if (initDataArg) {
  bad('ни одна схема не распознала подпись', 'секрет не тот, что подписывал строку, либо параметры изменены в пути');
} else {
  bad('круговая подпись не сошлась', 'это не конфиг: сломан сам код подписи, вход сломается у всех');
}

if (initDataArg && verified) {
  const tsRaw = sample['timestamp'] ?? sample['vk_ts'];
  const ts = tsRaw ? Number(tsRaw) : Number.NaN;
  if (Number.isFinite(ts)) {
    const ageSec = Math.floor(Date.now() / 1000) - ts;
    if (ageSec > config.vk.initDataSourceTtlSec) {
      warn(
        'устаревшая строка запуска',
        `${ageSec}с назад при TTL ${config.vk.initDataSourceTtlSec}с: подпись верна, но вход по ней запрещён`
      );
    }
  }
  if (verified.scheme === VkSignatureScheme.LAUNCH_PARAMS) {
    warn(
      'приложена СТАРАЯ схема (launch_params)',
      'современные Mini Apps подписывают по mini_app — проверь, что фронт не отдаёт старый bridge'
    );
  }
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
