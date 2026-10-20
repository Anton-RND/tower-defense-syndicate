/**
 * Смоук-прогон отладочного стенда (Шаг 6).
 *
 * Дёргает реальные HTTP-маршруты реального сервера — не доменные функции напрямую.
 * В этом и смысл: автотесты vitest доказывают, что математика верна, а этот скрипт
 * доказывает, что она доходит до игрока через транспорт (auth, тики, журнал, отказы).
 *
 *   node server/scripts/smoke.mjs                  # http://127.0.0.1:3000
 *   STAND_URL=http://host:3000 node server/scripts/smoke.mjs
 *
 * Требует DEV_SIGNER_ENABLED=true: сценарии «возврат → долг» и посев соперников без
 * отладочных маршрутов невоспроизводимы.
 *
 * Покрытые модули (каждый — успешным действием И отказом домена, а не только 200 OK):
 *  - Materials: котировка станка, конверсия, повтор по тому же Idempotency-Key,
 *    зарядка станиума на потолок 24 ч, отказ при полном сроке, выход за пакет;
 *  - Workshop: стройка, частичное и полное ускорение, ускорение всей очереди,
 *    переработка хлама + ретрай сдачи (duplicate=true без мутации состояния);
 *  - Shop: заказ → подтверждение → повторный вебхук (duplicate) → возврат;
 *  - Ads: сессия → второе открытие при живом показе → клим по чужому id → награда →
 *    повторный клим;
 *  - PvP: посев соперников, подбор, два рейда на ЗАФИКСИРОВАННЫХ ботов (поле защитника
 *    обязано давать множитель 0.75 — на случайном сопернике это лотерея), пустой состав,
 *    атака на себя;
 *  - Ledger: каждая причина движения реально дошла до журнала;
 *  - Долг: возврат уже потраченного пака уводит сырьё в минус и блокирует траты.
 *
 * Прогон безопасен повторами: ключи идемпотентности несут нонс запуска (RUN), а
 * соперники сеются заново. Код возврата: 0 — чисто, 1 — есть FAIL-строки.
 */
const BASE = process.env.STAND_URL || 'http://127.0.0.1:3000';
// Нонс на прогон: стенд живёт дольше одного запуска, а журнал гасит повторы по
// ключу идемпотентности. Без префикса второй прогон подряд получил бы тихий
// отказ записей («движение уже есть») вместо проверки.
const RUN = Date.now();

let failures = 0;
let token = '';

async function call(method, path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.idem) headers['Idempotency-Key'] = `${RUN}:${options.idem}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

/** Шаг с ожиданием успеха: падение шага — провал прогона, а не тихая строчка. */
async function step(name, method, path, body, options = {}) {
  const { status, json } = await call(method, path, body, options);
  if (status >= 200 && status < 300) {
    console.log(`ok   ${name} → ${status} ${summarize(json)}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} → ${status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  }
  return json;
}

/** Ожидаемый отказ: проверяем, что домен действительно сказал «нельзя». */
async function expectRefusal(name, method, path, body, code) {
  const { status, json } = await call(method, path, body);
  const actual = json?.error?.code;
  if (actual === code) {
    console.log(`ok   ${name} → отказ ${status} ${actual}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} → ожидали ${code}, получили ${status} ${actual ?? JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

function summarize(json) {
  const result = json.result;
  if (result === undefined) return '';
  const keys = ['spent', 'yielded', 'cost', 'granted', 'duplicate', 'movements', 'attacksRemaining', 'count'];
  return keys
    .filter((key) => result[key] !== undefined && result[key] !== null)
    .map((key) => `${key}=${JSON.stringify(result[key])}`)
    .join(' ');
}

const money = (economy) => {
  const a = economy.asterium;
  const m = economy.materials;
  return `астерий купл/зараб ${a.purchased}/${a.earned} (блок: ${a.blocked}) · хро ${m.chronium} · вольфрам ${m.wolfram} · станиум ${m.stanium}`;
};

async function main() {
  console.log(`# смоук стенда ${BASE}`);

  const health = await call('GET', '/health');
  console.log(`     /health → ${JSON.stringify(health.json)}`);
  if (!health.json?.dev) {
    console.log('FAIL: стенд требует DEV_SIGNER_ENABLED=true — отладочные маршруты выключены');
    process.exit(1);
  }

  const login = await step('dev-login', 'POST', '/v1/auth/dev-login', { socialId: `smoke-${Date.now()}` });
  token = login.token;
  const economy = await step('GET /v1/economy', 'GET', '/v1/economy');
  console.log(`     ${money(economy.economy)}`);

  // ─── Молекулярный станок: курс, списание, идемпотентность ──────────────────────
  await step('грант астерия', 'POST', '/v1/dev/grant', { asteriumEarned: 500 });
  const quote = await step('котировка станка', 'GET', '/v1/materials/conversion?metal=black_metal&amount=50');
  console.log(`     50 астерия → ${quote.quote?.yields} чёрного металла (курс ×${quote.quote?.rate})`);
  const converted = await step('перегнать астерий', 'POST', '/v1/materials/convert', { metal: 'black_metal', amount: 50 }, { idem: 'smoke-conv-1' });
  console.log(`     ${money(converted.economy)} · чёрного металла ${converted.economy?.metals?.black_metal}`);
  const duplicate = await step('повтор тем же Idempotency-Key', 'POST', '/v1/materials/convert', { metal: 'black_metal', amount: 50 }, { idem: 'smoke-conv-1' });
  if (duplicate.result?.duplicate !== true || duplicate.economy?.metals?.black_metal !== converted.economy?.metals?.black_metal) {
    failures += 1;
    console.log('FAIL: повтор с тем же ключом либо не распознан, либо списал астерий второй раз');
  } else {
    console.log('ok   повтор с тем же ключом: duplicate=true, баланс металла не тронут');
  }
  await expectRefusal('станок в неизвестный металл', 'POST', '/v1/materials/convert', { metal: 'unobtainium', amount: 10 }, 'CONVERSION_TARGET_INVALID');
  await expectRefusal('станок дробным количеством', 'POST', '/v1/materials/convert', { metal: 'black_metal', amount: 1.5 }, 'VALIDATION_ERROR');

  // ─── Станиумный модуль: накопление срока и потолок 24 часа ─────────────────────
  await step('грант станиума', 'POST', '/v1/dev/grant', { stanium: 200 });
  const charged = await step('зарядить на потолок (96)', 'POST', '/v1/materials/stanium/charge', { units: 96 }, { idem: 'smoke-sta-1' });
  const field = charged.result?.field;
  const hours = field?.until ? Math.round(((new Date(field.until).getTime() - Date.now()) / 36e5) * 100) / 100 : NaN;
  console.log(`     поле: активно=${field?.active} · срок ${hours} ч · множитель ${field?.speedMultiplier} · −${field?.slowPercent}%`);
  if (!(hours > 23.9 && hours < 24.1)) {
    failures += 1;
    console.log(`FAIL: 96 станиума ≠ 24 часам поля (получилось ${hours} ч)`);
  }
  await expectRefusal('зарядка при полном сроке', 'POST', '/v1/materials/stanium/charge', { units: 1 }, 'STANIUM_CHARGE_INVALID');
  await expectRefusal('зарядка больше пакета', 'POST', '/v1/materials/stanium/charge', { units: 200 }, 'VALIDATION_ERROR');
  // ─── Мастерская: стройка, частичное и полное ускорение хронием ─────────────────
  await step('грант ресурсов', 'POST', '/v1/dev/grant', {
    ferrum: 20000, silicium: 10000, uranium: 2000, plasma: 500,
    black_metal: 5000, colored_metal: 2000, precious_metal: 1000,
    chips: 500, batteries: 500, boards: 200, transmissions: 100, engines: 50, ammo_casings: 200,
    chronium: 300
  });
  const laser = await step('стройка башни (10 мин)', 'POST', '/v1/workshop/build', { code: 'tower_laser_mk1' });
  const laserJob = laser.result?.job?.id;
  const partial = await step('ускорить частично (1 хро.)', 'POST', `/v1/workshop/build/${laserJob}/speedup`, { chronium: 1 }, { idem: 'smoke-rush-1' });
  const leftMs = partial.result?.job?.endsAt ? new Date(partial.result.job.endsAt).getTime() - Date.now() : NaN;
  console.log(`     списано ${partial.result?.cost} хро., срезано ${partial.result?.savedMs} мс, осталось ${Math.round(leftMs / 1000)} с`);
  if (partial.result?.cost !== 1 || partial.result?.savedMs !== 60000) {
    failures += 1;
    console.log('FAIL: 1 хрониум должен срезать ровно 60 секунд за 1 единицу');
  }
  const finished = await step('добить досрочно', 'POST', `/v1/workshop/build/${laserJob}/speedup`, {});
  console.log(`     предметов выдано: ${finished.result?.items?.length ?? 0} · роботов свободно ${finished.result?.free}`);

  const drone = await step('стройка дрона (20 мин)', 'POST', '/v1/workshop/build', { code: 'drone_cargo_mk1' });
  const speedupAll = await step('ускорить всю очередь', 'POST', '/v1/workshop/build/speedup-all', {}, { idem: 'smoke-rush-all' });
  console.log(`     работ ускорено: ${speedupAll.result?.count} · списано ${speedupAll.result?.cost} хро. (со скидкой на пачку)`);

  // ─── Цех переработки: хлам → металлы + сырьё ──────────────────────────────────
  const recycled = await step('сдать 50 чипов', 'POST', '/v1/workshop/recycle', { junk: 'chips', amount: 50 }, { idem: 'smoke-rec-1' });
  console.log(`     выход: ${JSON.stringify(recycled.result?.yielded)} · энергии ${recycled.result?.energy}`);
  // Лимит пакета (10 000) и остаток запаса — РАЗНЫЕ откази: сверх пакета валидатор
  // отсекает ещё до модуля, а «больше, чем есть» — это уже INSUFFICIENT_FUNDS.
  await expectRefusal('сдать больше, чем есть', 'POST', '/v1/workshop/recycle', { junk: 'chips', amount: 9000 }, 'INSUFFICIENT_FUNDS');
  await expectRefusal('сдать сверх лимита пакета', 'POST', '/v1/workshop/recycle', { junk: 'chips', amount: 100000 }, 'VALIDATION_ERROR');
  await expectRefusal('сдать неизвестный хлам', 'POST', '/v1/workshop/recycle', { junk: 'planks', amount: 1 }, 'VALIDATION_ERROR');
  // Ретрай той же сдачи тем же ключом: хлам обязан остаться на складе, награда — не
  // удвоиться, журнал — не получить вторую пачку движений.
  const replay = await step(
    'ретрай сдачи с тем же Idempotency-Key',
    'POST',
    '/v1/workshop/recycle',
    { junk: 'chips', amount: 50 },
    { idem: 'smoke-rec-1' }
  );
  const replayOk =
    replay.result?.duplicate === true &&
    Object.keys(replay.result?.yielded ?? {}).length === 0 &&
    replay.result?.junkLeft === recycled.result?.junkLeft &&
    replay.result?.movements === 0;
  if (!replayOk) {
    failures += 1;
    console.log(
      `FAIL: ретрай сдачи не должен менять состояние (duplicate=${replay.result?.duplicate}, выход ${JSON.stringify(replay.result?.yielded)}, хлам ${replay.result?.junkLeft} при ${recycled.result?.junkLeft})`
    );
  } else {
    console.log('ok   ретрай сдачи: duplicate=true, хлам и награда не тронуты');
  }

  // ─── Магазин: пак сырья, подтверждение площадкой, возврат ─────────────────────
  const order = await step('заказ wolfram_pack_50', 'POST', '/v1/shop/orders', { sku: 'wolfram_pack_50' });
  const orderId = order.result?.order?.id;
  const paid = await step('подтвердить оплату (dev-постбэк)', 'POST', '/v1/dev/payments/confirm', { orderId, providerOrderId: 'vk-1' });
  console.log(`     выдано: ${paid.result?.granted} · вольфрам ${paid.economy?.materials?.wolfram}`);
  const requoted = await step('повторное подтверждение тем же заказом', 'POST', '/v1/dev/payments/confirm', { orderId });
  if (requoted.result?.duplicate !== true || requoted.economy?.materials?.wolfram !== paid.economy?.materials?.wolfram) {
    failures += 1;
    console.log('FAIL: повторный вебхук обязан быть duplicate=true без второй выдачи');
  } else {
    console.log('ok   повторный вебхук: duplicate=true, вольфрам выдан один раз');
  }
  const refunded = await step('возврат платежа', 'POST', '/v1/dev/payments/refund', { orderId });
  console.log(`     после возврата: вольфрам ${refunded.economy?.materials?.wolfram} (был ${paid.economy?.materials?.wolfram})`);
  if (refunded.economy?.materials?.wolfram !== 0) {
    failures += 1;
    console.log('FAIL: возврат обязан снять ровно то, что выдал пак');
  }


  // ─── Rewarded-реклама: сессия → подтверждение → награда ───────────────────────
  // Порядок важен: второе открытие проверяется ПРИ ЖИВОМ показе. Если сначала
  // заклеймить первый, открытой сессии уже не будет — и проверка станет декоративной.
  const session = await step('открыть показ (ad_stanium_1)', 'POST', '/v1/ads/session', { sku: 'ad_stanium_1' });
  const sessionId = session.result?.session?.id;
  await expectRefusal('второе открытие при живом показе', 'POST', '/v1/ads/session', { sku: 'ad_energy_25' }, 'AD_SESSION_REQUIRED');
  await expectRefusal('клим по чужому id сессии', 'POST', '/v1/ads/claim', { sessionId: 'ad-chuzoy-id' }, 'AD_SESSION_REQUIRED');
  await expectRefusal('неизвестный sku показа', 'POST', '/v1/ads/session', { sku: 'ad_unobtainium' }, 'VALIDATION_ERROR');
  const claimed = await step('подтвердить показ (dev-постбэк)', 'POST', '/v1/ads/claim', { sessionId });
  console.log(`     награда: ${claimed.result?.granted} · станиум ${claimed.economy?.materials?.stanium}`);
  await expectRefusal('повторный клим той же сессии', 'POST', '/v1/ads/claim', { sessionId }, 'AD_SESSION_REQUIRED');

  // ─── PvP: соперник со станиумным полем ────────────────────────────────────────
  // Рейдём КОНКРЕТНО посеянного бота, а не случайного из подборки: в пуле остаются
  // аккаунты прежних прогонов без поля, и проверка множителя превратилась бы в
  // лотерею (прошлый прогон показал 1 вместо 0.75 именно поэтому).
  const seededView = await step('посеять 4 соперников (поле 2 ч у каждого)', 'POST', '/v1/dev/seed-opponents', {
    count: 4,
    stanium: 8
  });
  const bots = seededView.result?.seeded ?? [];
  const found = await step('найти соперника (подбор жив)', 'GET', '/v1/pvp/opponent');
  console.log(
    `     подбор: ${found.opponent?.label} · рейтинг ${found.opponent?.rating} · годен ${found.opponent?.report?.ready}`
  );
  if (!found.opponent?.defenderId) {
    failures += 1;
    console.log('FAIL: матчмейкинг не дал соперника после посева');
  }
  const fresh = await step('витрина после постройки дронов', 'GET', '/v1/economy');
  const drones = (fresh.economy?.inventory ?? []).filter((item) => item.kind === 'drone');
  const targets = bots.map((bot) => bot.userId).filter(Boolean);
  if (targets.length === 0) {
    failures += 1;
    console.log('FAIL: посев не вернул id соперников — рейд не проверен');
  } else if (drones.length === 0) {
    failures += 1;
    console.log('FAIL: у игрока нет дронов — рейд не проверен');
  } else {
    // Два рейда на двух разных ботов: поле должно работать не на одном примере.
    for (const [index, defenderId] of targets.slice(0, 2).entries()) {
      const raid = await step(`рейд №${index + 1} на посеянного бота`, 'POST', '/v1/pvp/raid', {
        defenderId,
        armyItemIds: drones.slice(0, 2).map((d) => d.id)
      });
      const battle = raid.result?.battle;
      console.log(
        `     исход ${battle?.outcome} · тиков ${battle?.ticks} · множитель атакующего ${battle?.attackerSpeedMultiplier} · рейтинг ${raid.result?.rating?.attacker?.before} → ${raid.result?.rating?.attacker?.after}`
      );
      console.log(
        `     лут ${JSON.stringify(raid.result?.loot)} · украдено ${JSON.stringify(raid.result?.stolen)} · атак осталось ${raid.result?.attacksRemaining}`
      );
      if (battle?.attackerSpeedMultiplier !== 0.75) {
        failures += 1;
        console.log(`FAIL: поле защитника должно было замедлить атакующего до 0.75, а множитель = ${battle?.attackerSpeedMultiplier}`);
      }
      // Сеть и топливо — часть отчёта боя, а не внутренний детали движка: разбор
      // «почему я проиграл» обязан отвечать на них тем же запросом, что и на исход.
      const powerReport = battle?.power;
      const fuelReport = battle?.fuel;
      if (!powerReport || typeof powerReport.unpowered !== 'number' || typeof powerReport.overheatEvents !== 'number') {
        failures += 1;
        console.log('FAIL: battle.power не дошёл до клиента — оборона не объясняет своё молчание');
      }
      if (!fuelReport || typeof fuelReport.attackerDeuterium !== 'number' || typeof fuelReport.defenderDeuterium !== 'number') {
        failures += 1;
        console.log('FAIL: battle.fuel не дошёл до клиента — расход дейтерия не проверяем');
      } else {
        console.log(`     сеть/топливо: обесточено ${powerReport.unpowered} башен · перегревов ${powerReport.overheatEvents} · дейтерий атака ${fuelReport.attackerDeuterium}, оборона ${fuelReport.defenderDeuterium}`);
      }
      if (index === 0) {
        await expectRefusal('пустой состав', 'POST', '/v1/pvp/raid', { defenderId, armyItemIds: [] }, 'ARMY_INVALID');
        await expectRefusal('атака на самого себя', 'POST', '/v1/pvp/raid', {
          defenderId: fresh.user?.id,
          armyItemIds: drones.slice(0, 2).map((d) => d.id)
        }, 'VALIDATION_ERROR');
      }
    }
  }

  const ledger = await step('журнал', 'GET', '/v1/ledger?limit=100');
  const reasons = [...new Set((ledger.entries ?? []).map((entry) => entry.reason))];
  console.log(`     причины в журнале: ${reasons.join(', ')}`);
  for (const expected of ['convert', 'stanium_field', 'recycle', 'purchase', 'refund', 'ad_reward', 'craft', 'upgrade']) {
    if (!reasons.includes(expected)) {
      failures += 1;
      console.log(`FAIL: в журнале нет причины «${expected}» — соответствующий маршрут не оставил следа`);
    }
  }

  // ─── Долг по сырью: возврат потраченного пака уводит баланс в минус ────────────
  // Отдельный аккаунт без единой единицы хрониума: иначе «минус» невозможно
  // отличить от остатка гранта, и проверка становится декоративной.
  const debtLogin = await step('dev-login (долг по хрониуму)', 'POST', '/v1/auth/dev-login', { socialId: `smoke-debt-${Date.now()}` });
  token = debtLogin.token;
  await step('грант на тяжёлую постройку', 'POST', '/v1/dev/grant', {
    ferrum: 2000, uranium: 500, colored_metal: 500, precious_metal: 200, wolfram: 200, engines: 10
  });
  const plasma = await step('стройка плазменного резонатора (3 ч)', 'POST', '/v1/workshop/build', { code: 'tower_plasma_mk3' });
  const plasmaJob = plasma.result?.job?.id;
  const chroniumOrder = await step('заказ chronium_pack_60', 'POST', '/v1/shop/orders', { sku: 'chronium_pack_60' });
  const chroniumOrderId = chroniumOrder.result?.order?.id;
  const chroniumPaid = await step('подтвердить оплату пака', 'POST', '/v1/dev/payments/confirm', { orderId: chroniumOrderId, providerOrderId: 'vk-2' });
  console.log(`     хрониум после покупки: ${chroniumPaid.economy?.materials?.chronium}`);
  const spent = await step('весь хрониум в ускорение', 'POST', `/v1/workshop/build/${plasmaJob}/speedup`, { chronium: 60 }, { idem: 'smoke-debt-rush' });
  console.log(`     списано ${spent.result?.cost} хро. · остаток ${spent.economy?.materials?.chronium}`);
  const debtRefund = await step('возврат уже потраченного пака', 'POST', '/v1/dev/payments/refund', { orderId: chroniumOrderId });
  const debt = debtRefund.economy?.materials?.chronium;
  console.log(`     хрониум после возврата: ${debt} (долг)`);
  if (!(typeof debt === 'number' && debt < 0)) {
    failures += 1;
    console.log('FAIL: возврат уже потраченного пака обязан увести сырьё в минус — это блокировка трат');
  }
  await expectRefusal('трата из долга', 'POST', `/v1/workshop/build/${plasmaJob}/speedup`, { chronium: 1 }, 'INSUFFICIENT_FUNDS');

  // ─── Инфраструктурный контур: сеть, сооружения, SEC ────────────────────────────
  // Автотесты vitest доказывают математику; этот блок доказывает, что она доехала до
  // клиента через транспорт. Отдельных причин две: витрина — единственный источник
  // правды для игрока («почему ASIC молчит»), а маршрут стройки сооружения — единственный
  // путь, которым эта физика вообще достижима в игре.
  const fail = (message) => {
    failures += 1;
    console.log(`FAIL: ${message}`);
  };

  const phys = await step('витрина сети и сооружений', 'GET', '/v1/economy');
  const eco = phys.economy ?? {};
  const power = eco.power ?? {};
  const structs = eco.structures ?? [];
  console.log(
    `     мощность ${power.supplyOnline}/${power.demandOnline} кВт (резерв ${power.reserve}) · ` +
      `тепло ${power.heatLoad}/${power.coolingCap} · азот ${power.nitrogenPerHour}/ч · SEC ${power.secPerHour}/ч`
  );
  console.log(`     реестр сооружений: ${structs.length} видов · SEC в кошельке ${eco.resources?.sec} (тратится ${eco.resources?.secSpendable})`);

  if (typeof eco.resources?.sec !== 'number') fail('economy.resources.sec отсутствует — SEC ещё не деньги');
  if (typeof eco.resources?.secSpendable !== 'number') fail('economy.resources.secSpendable отсутствует — витрине нечего показать');
  if (typeof eco.resources?.sec === 'number' && typeof eco.resources?.secSpendable === 'number' &&
    eco.resources.secSpendable !== Math.floor(eco.resources.sec)) fail('secSpendable обязан быть floor(sec)');
  if (typeof power.secPerHour !== 'number') fail('power.secPerHour отсутствует — ставка монеты не видна');
  if (typeof power.supplyOnline !== 'number' || typeof power.coolingCap !== 'number') fail('power обязана отдавать контуры мощности и тепла');
  if (structs.length === 0) fail('economy.structures пуст — строить нечего');
  if (!structs.every((s) => typeof s.count === 'number' && typeof s.power === 'number' && typeof s.unlocked === 'boolean'))
    fail('у сооружения нет count/power/unlocked — фронт не сможет ни показать, ни разрешить стройку');

  const secGrant = await step('грант SEC', 'POST', '/v1/dev/grant', { sec: 500 });
  if (!((secGrant.economy?.resources?.sec ?? 0) >= 500)) fail('грант SEC не дошёл до кошелька');

  await step('грант на сооружения', 'POST', '/v1/dev/grant', {
    ferrum: 200000, silicium: 80000, chips: 800, black_metal: 40000, colored_metal: 40000, chronium: 400
  });
  const supplyBefore = power.supplyOnline ?? 0;
  const structureJob = await step('поставить плазменный конвертер', 'POST', '/v1/workshop/build', { code: 'reactor_plasma_mk1' });
  // Сооружение и предмет строятся одним маршрутом и РАЗНЫМИ контрактами: фронт по
  // `structure` решает, рисовать здание или штуку в инвентаре, и угадывать это по коду
  // ему нельзя.
  if (!structureJob.result?.structure) fail('стройка сооружения обязана отвечать `structure`');
  if (structureJob.result?.blueprint) fail('стройка сооружения не обязана отвечать `blueprint` — иначе фронт положит реактор в клетку лабиринта');

  await step('добить очередь сборки', 'POST', '/v1/workshop/build/speedup-all', {}, { idem: 'smoke-phys-rush' });
  const built = await step('витрина после сборки конвертера', 'GET', '/v1/economy');
  const reactor = (built.economy?.structures ?? []).find((s) => s.id === 'reactor_plasma_mk1');
  if (!reactor || reactor.count < 1) fail('счётчик конвертера не вырос после добора очереди — сооружение не приехало на базу');
  if ((built.economy?.power?.supplyOnline ?? 0) <= supplyBefore)
    fail(`генерация не выросла после сборки конвертера (${supplyBefore} → ${built.economy?.power?.supplyOnline}) — сеть не читает состав базы`);

  await step('журнал по причине industry', 'GET', '/v1/ledger?reason=industry&limit=10');
  await expectRefusal('неизвестная причина журнала', 'GET', '/v1/ledger?reason=bogus', undefined, 'VALIDATION_ERROR');

  console.log(failures === 0 ? '\nсмоук чист: 0 провалов' : `\nсмоук: провалов ${failures}`);
  process.exit(failures === 0 ? 0 : 1);

}

main().catch((error) => {
  console.log(`FAIL исключение прогона: ${error?.stack ?? error}`);
  process.exit(1);
});


