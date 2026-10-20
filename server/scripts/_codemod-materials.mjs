import fs from 'node:fs';
import path from 'node:path';

/**
 * Одноразовый кодомод: кританий → четыре материала.
 * Порядок правил важен: сначала специальные (RUSH_* → CHRONIUM_*), затем общие.
 */
const ROOT = process.cwd();
const DIRS = ['server/src', 'server/test', 'frontend/src'];
const EXT = /\.(ts|tsx|mts)$/;

const RULES = [
  // 1. Ускорение стройки переходит с донатной валюты на хрониум.
  [/RUSH_MS_PER_CRITANIUM/g, 'CHRONIUM_MS_PER_UNIT'],
  [/RUSH_MIN_COST/g, 'CHRONIUM_MIN_COST'],
  [/RUSH_BUNDLE_DISCOUNT/g, 'CHRONIUM_BUNDLE_DISCOUNT'],
  // 2. Идентификаторы донатной валюты.
  [/premiumTotal/g, 'asteriumTotal'],
  [/spendCritanium/g, 'spendAsterium'],
  [/refundCritanium/g, 'refundAsterium'],
  [/CritaniumWalletName/g, 'AsteriumWalletName'],
  [/CritaniumCurrency/g, 'AsteriumCurrency'],
  [/CRITANIUM_CURRENCY/g, 'ASTERIUM_CURRENCY'],
  [/CritaniumSku/g, 'AsteriumSku'],
  [/PremiumWallet/g, 'AsteriumWallet'],
  [/PremiumView/g, 'AsteriumView'],
  [/PremiumDoc/g, 'AsteriumDoc'],
  [/premiumSchema/g, 'asteriumSchema'],
  [/withCritanium/g, 'withAsterium'],
  [/rewardCritanium/g, 'rewardAsterium'],
  [/msPerCritanium/g, 'msPerChronium'],
  // 3. Остатки в строках, SKU и комментариях.
  [/critanium/g, 'asterium'],
  [/Critanium/g, 'Asterium'],
  [/CRITANIUM/g, 'ASTERIUM'],
  // 4. Русская морфология (порядок от длинных форм к коротким, чтобы не резать частично).
  [/Кританиума/g, 'Астерия'],
  [/Кританиум/g, 'Астерий'],
  [/кританиума/g, 'астерия'],
  [/кританиум/g, 'астерий'],
  [/кританией/g, 'астерием'],
  [/кританиям/g, 'астериям'],
  [/кританий/g, 'астериев'],
  [/кританию/g, 'астерию'],
  [/кританием/g, 'астерием'],
  [/критание/g, 'астерии'],
  [/кританье/g, 'астерии'],
  // 5. Структура документа: premium → materials.asterium.
  [/\baccount\.premium\b/g, 'account.materials.asterium'],
  [/\bfresh\.premium\b/g, 'fresh.materials.asterium'],
  [/\bbase\.premium\b/g, 'base.materials.asterium'],
  [/\bnext\.premium\b/g, 'next.materials.asterium'],
  [/\binviter\.premium\b/g, 'inviter.materials.asterium'],
  [/\bsettled\.premium\b/g, 'settled.materials.asterium']
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXT.test(entry.name)) yield full;
  }
}

const changed = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const [pattern, replacement] of RULES) after = after.replace(pattern, replacement);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(path.relative(ROOT, file));
    }
  }
}
console.log(changed.length + ' файлов изменено');
for (const f of changed) console.log(' - ' + f);
