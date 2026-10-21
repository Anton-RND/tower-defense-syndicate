import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SIGN_KEYS,
  VkSignatureScheme,
  buildLaunchParamsCheckString,
  buildMiniAppCheckString,
  classifyVkSignShape,
  diagnoseVkInitData,
  encodeVkParams,
  formatVkPass,
  inspectVkSignatures,
  parseVkParams,
  parseVkRawParams,
  safeEquals,
  signVkLaunchParams,
  signVkMiniApp,
  signVkParams,
  signatureOf,
  verifyVkInitDataParams,
  verifyVkSignature,
  type VkParams
} from '../src/modules/auth/vk.signature.js';

/**
 * Подпись параметров запуска ВКонтакте.
 *
 * Здесь проверяется то, что невозможно проверить «на глаз» и что стоит отказа
 * входа целой аудитории:
 *  1. формула строки проверки — по золотому вектору, посчитанному ВТОРЫМ способом
 *     (`createHmac` прямо в тесте), а не круговой проверкой самой себя;
 *  2. оба имени поля подписи (`sign` из документа и `sig` — алиас из ходячих
 *     сборок bridge): требовать ровно `sign` — значит отказать игроку с корректно
 *     подписанной строкой;
 *  3. порядок проходов по байтам: сырые значения обязаны сходиться, раскрытые —
 *     только как фолбэк, иначе живой `session_hash` с `+` внутри ломается молча.
 */

const SECRET = 'test-vk-secret';
const APP_ID = 53377165;

/** Набор параметров Mini Apps БЕЗ подписи — исходник для всех векторов. */
function baseParams(overrides: VkParams = {}): VkParams {
  return {
    allow_preview: '0',
    is_app_user: '1',
    language: 'ru',
    platform: 'vk',
    realm: 'vk.com',
    session_hash: 'abC123-_9',
    sign_version: '2',
    ts: '1700000000',
    vk_app_id: String(APP_ID),
    viewer_id: '123456789',
    ...overrides
  };
}

function withMiniAppSign(params: VkParams): VkParams {
  const copy: VkParams = { ...params };
  copy['sign'] = signVkMiniApp(copy, APP_ID, SECRET);
  return copy;
}

describe('vk/signature: золотой вектор launch_params', () => {
  const params: VkParams = {
    vk_anonymous_id: '0',
    vk_app_id: String(APP_ID),
    vk_is_secure: '0',
    vk_protocol: 'https',
    vk_ts: '1700000000',
    vk_user_id: '123456789'
  };
  const checkString =
    'vk_anonymous_id=0&vk_app_id=53377165&vk_is_secure=0&vk_protocol=https&vk_ts=1700000000&vk_user_id=123456789';

  it('строка проверки — отсортированные vk_* пары, без чужих ключей', () => {
    expect(buildLaunchParamsCheckString({ ...params, sign: 'x', hash: 'inv_y', foo: 'bar' })).toBe(checkString);
  });

  it('подпись совпадает с независимо посчитанным HMAC (base64url без padding)', () => {
    const golden = createHmac('sha256', SECRET).update(checkString, 'utf8').digest('base64url');
    const sign = signVkLaunchParams(params, SECRET);
    expect(sign).toBe(golden);
    // Padding — частая причина «подпись на символ короче»: здесь его быть не должно.
    expect(sign.endsWith('=')).toBe(false);
  });

  it('эта же строка проходит верификацию по схеме launch_params', () => {
    const signed = { ...params, sign: signVkLaunchParams(params, SECRET) };
    expect(verifyVkSignature(signed, { appId: APP_ID, secretKey: SECRET })?.scheme).toBe(
      VkSignatureScheme.LAUNCH_PARAMS
    );
  });

  it('чужой секрет не совпадает ни одной схемой', () => {
    const signed = { ...params, sign: signVkLaunchParams(params, 'attacker-secret') };
    expect(verifyVkSignature(signed, { appId: APP_ID, secretKey: SECRET })).toBeNull();
  });
});

describe('vk/signature: mini_app', () => {
  it('service_key привязан к app_id: другой ключ даёт другую подпись', () => {
    const params = { viewer_id: '1', ts: '1700000000' };
    expect(signVkMiniApp(params, APP_ID, SECRET)).not.toBe(signVkMiniApp(params, APP_ID + 1, SECRET));
  });

  it('hash и sign не участвуют в строке проверки', () => {
    const plain = baseParams();
    const withHash = baseParams({ hash: 'inv_0f1e2d3c4b5a' });
    expect(buildMiniAppCheckString(withHash)).toBe(buildMiniAppCheckString(plain));
    // `session_hash=` содержит подстроку «hash=», поэтому проверяется позиция ключа.
    expect(buildMiniAppCheckString(withHash)).not.toMatch(/(^|&)hash=/);
    expect(buildMiniAppCheckString({ ...withHash, sign: 'x', sig: 'y' })).not.toMatch(/(^|&)(sign|sig)=/);
  });

  it('круговая проверка: подпись, снятая кодом, принимается кодом', () => {
    expect(verifyVkSignature(withMiniAppSign(baseParams()), { appId: APP_ID, secretKey: SECRET })?.scheme).toBe(
      VkSignatureScheme.MINI_APP
    );
  });

  it('изменение любого подписанного поля убивает подпись', () => {
    const params = withMiniAppSign(baseParams());
    params['viewer_id'] = '987654321';
    expect(verifyVkSignature(params, { appId: APP_ID, secretKey: SECRET })).toBeNull();
  });
});

describe('vk/signature: имя поля подписи — sign и sig', () => {
  const launch: VkParams = { vk_app_id: String(APP_ID), vk_ts: '1700000000', vk_user_id: '123456789' };

  it('signatureOf находит любое из двух имён', () => {
    expect(signatureOf({ sign: 'abc' })).toEqual({ key: 'sign', value: 'abc' });
    expect(signatureOf({ sig: 'abc' })).toEqual({ key: 'sig', value: 'abc' });
    expect(signatureOf({ sign: '', sig: 'abc' })).toEqual({ key: 'sig', value: 'abc' });
    expect(signatureOf({})).toBeNull();
    expect(signatureOf({ sign: '' })).toBeNull();
  });

  it('подпись в поле sig принимается верификацией наравне со sign', () => {
    const value = signVkLaunchParams(launch, SECRET);
    const options = { appId: APP_ID, secretKey: SECRET };
    expect(verifyVkSignature({ ...launch, sign: value }, options)?.matched).toBe(true);
    const viaSig = verifyVkSignature({ ...launch, sig: value }, options);
    expect(viaSig?.matched).toBe(true);
    expect(viaSig?.signKey).toBe('sig');
  });

  it('оба имени исключены из строки проверки: подпись не соучастник себя', () => {
    expect(buildLaunchParamsCheckString({ ...launch, sign: 'x', sig: 'y' })).toBe(
      buildLaunchParamsCheckString(launch)
    );
    expect(buildMiniAppCheckString({ ...launch, sign: 'x', sig: 'y' })).toBe(buildMiniAppCheckString(launch));
  });

  it('inspectVkSignatures сообщает, в каком поле лежала подпись', () => {
    const value = signVkMiniApp(launch, APP_ID, SECRET);
    const checks = inspectVkSignatures({ ...launch, sig: value }, { appId: APP_ID, secretKey: SECRET });
    expect(checks.map((c) => c.signKey)).toEqual(['sig', 'sig']);
    expect(checks.find((c) => c.scheme === VkSignatureScheme.MINI_APP)?.matched).toBe(true);
  });

  it('SIGN_KEYS — ровно два имени: список является договором верификатора', () => {
    expect([...SIGN_KEYS]).toEqual(['sign', 'sig']);
  });
});

describe('vk/signature: разбор параметров — сырые и раскрытые байты', () => {
  it('decode по умолчанию раскрывает %2B в +, а + в пробел', () => {
    const parsed = parseVkParams('session_hash=a%2Bb&language=ru+ru');
    expect(parsed['session_hash']).toBe('a+b');
    expect(parsed['language']).toBe('ru ru');
  });

  it('decode:false оставляет ровно те байты, которые подписывала площадка', () => {
    const parsed = parseVkRawParams('session_hash=a%2Bb&language=ru+ru');
    expect(parsed['session_hash']).toBe('a%2Bb');
    expect(parsed['language']).toBe('ru+ru');
  });

  it('ведущий ? или # снимаются; пустая строка даёт пустой объект', () => {
    expect(Object.keys(parseVkParams('')).length).toBe(0);
    expect(parseVkParams('?a=1&b=2')).toEqual({ a: '1', b: '2' });
    expect(parseVkParams('#a=1')).toEqual({ a: '1' });
  });

  it('значение без = остаётся пустой строкой, а не undefined', () => {
    expect(parseVkParams('flag&a=1')).toEqual({ flag: '', a: '1' });
  });

  it('битая процентная последовательность не роняет разбор', () => {
    expect(parseVkParams('a=%E2%82&b=ok')).toEqual({ a: '%E2%82', b: 'ok' });
  });
});

describe('vk/signature: encodeVkParams', () => {
  it('чистый сериализатор: переносит всё, что дали, включая hash и подписи', () => {
    const encoded = encodeVkParams({ b: '2', a: 'x+y', sign: 'dead', hash: 'inv_0f1e2d3c' });
    expect(encoded).toBe('a=x%2By&b=2&hash=inv_0f1e2d3c&sign=dead');
  });

  it('round-trip: раскрытый разбор возвращает исходные значения байт в байт', () => {
    const params: VkParams = { session_hash: 'ab+cd/ef', viewer_id: '1', ts: '1700000000' };
    expect(parseVkParams(encodeVkParams(params))).toEqual(params);
    // Сырой разбор оставляет процентные последовательности: в этом и смысл двух проходов.
    expect(parseVkRawParams(encodeVkParams(params))['session_hash']).toBe('ab%2Bcd%2Fef');
  });
});

describe('vk/signature: signVkParams — генератор и верификатор одним кодом', () => {
  it('mini_app: собранная строка проходит верификацию', () => {
    const signed = signVkParams(baseParams(), { appId: APP_ID, secretKey: SECRET });
    const verified = verifyVkInitDataParams(signed.initData, { appId: APP_ID, secretKey: SECRET });
    expect(verified?.check.scheme).toBe(VkSignatureScheme.MINI_APP);
    expect(verified?.source).toBe('raw');
    expect(verified?.params['viewer_id']).toBe('123456789');
  });

  it('launch_params: то же для старой схемы', () => {
    const signed = signVkParams({ vk_app_id: String(APP_ID), vk_ts: '1700000000', vk_user_id: '42' }, {
      appId: APP_ID,
      secretKey: SECRET,
      scheme: VkSignatureScheme.LAUNCH_PARAMS
    });
    expect(verifyVkInitDataParams(signed.initData, { appId: APP_ID, secretKey: SECRET })?.check.scheme).toBe(
      VkSignatureScheme.LAUNCH_PARAMS
    );
  });

  it('signKey:sig кладёт подпись в sig, и она принимается', () => {
    const signed = signVkParams(baseParams(), { appId: APP_ID, secretKey: SECRET, signKey: 'sig' });
    expect(signed.initData).toContain('&sig=');
    expect(signed.initData.indexOf('&sign=')).toBe(-1);
    expect(verifyVkSignature(parseVkRawParams(signed.initData), { appId: APP_ID, secretKey: SECRET })?.matched).toBe(
      true
    );
  });

  it('hash летит в initData, но в подпись не входит', () => {
    const signed = signVkParams(baseParams({ hash: 'inv_0f1e2d3c4b5a' }), { appId: APP_ID, secretKey: SECRET });
    expect(signed.initData).toContain('hash=inv_0f1e2d3c4b5a');
    expect(signed.checkString).not.toMatch(/(^|&)hash=/);
    expect(verifyVkInitDataParams(signed.initData, { appId: APP_ID, secretKey: SECRET })?.params['hash']).toBe(
      'inv_0f1e2d3c4b5a'
    );
  });

  it('подменённое значение подписи отбрасывается обоими проходами', () => {
    const signed = signVkParams(baseParams(), { appId: APP_ID, secretKey: SECRET });
    expect(
      verifyVkInitDataParams(signed.initData.replace(signed.sign, 'deadbeef'), { appId: APP_ID, secretKey: SECRET })
    ).toBeNull();
  });
});

describe('vk/signature: двойной проход raw → decoded', () => {
  it('mini_app: спецсимволы в значениях ловятся вторым (раскрытым) проходом', () => {
    // Площадка подписала РАСКРЫТОЕ значение `A+B/C==`, а в строку запустила
    // `A%2BB%2FC%3D%3D`. Сырой проход обязан честно промахнуться, иначе
    // `session_hash` с base64-составляющей сломал бы вход.
    const signed = signVkParams(baseParams({ session_hash: 'A+B/C==' }), { appId: APP_ID, secretKey: SECRET });
    expect(signed.initData).toContain('session_hash=A%2BB%2FC%3D%3D');
    const options = { appId: APP_ID, secretKey: SECRET };

    expect(verifyVkSignature(parseVkRawParams(signed.initData), options)).toBeNull();
    expect(verifyVkSignature(parseVkParams(signed.initData), options)?.matched).toBe(true);

    const verified = verifyVkInitDataParams(signed.initData, options);
    expect(verified?.source).toBe('decoded');
    expect(verified?.params['session_hash']).toBe('A+B/C==');
  });

  it('launch_params: urlencoded-строка ловится первым (сырым) проходом', () => {
    // Старая схема подписывает именно закодированное представление: `%20`
    // участвует в check_string как `%20`, а не как пробел.
    const rawValue = 'a%20b';
    const body: VkParams = {
      vk_app_id: String(APP_ID),
      vk_ts: '1700000000',
      vk_user_id: '42',
      vk_note: rawValue
    };
    const initData = `vk_app_id=${APP_ID}&vk_note=${rawValue}&vk_ts=1700000000&vk_user_id=42&sign=${signVkLaunchParams(
      body,
      SECRET
    )}`;
    const options = { appId: APP_ID, secretKey: SECRET };

    expect(verifyVkSignature(parseVkRawParams(initData), options)?.matched).toBe(true);
    expect(verifyVkSignature(parseVkParams(initData), options)).toBeNull();
    expect(verifyVkInitDataParams(initData, options)?.source).toBe('raw');
  });

  it('значения без спецсимволов: оба прохода идентичны, выигрывает первый', () => {
    const signed = signVkParams(baseParams(), { appId: APP_ID, secretKey: SECRET });
    expect(verifyVkInitDataParams(signed.initData, { appId: APP_ID, secretKey: SECRET })?.source).toBe('raw');
  });

  it('пустая строка и строка без подписи дают null, а не исключение', () => {
    const options = { appId: APP_ID, secretKey: SECRET };
    expect(verifyVkInitDataParams('', options)).toBeNull();
    expect(verifyVkInitDataParams('viewer_id=1', options)).toBeNull();
  });
});

describe('vk/signature: safeEquals', () => {
  it('разные длины — false без исключения', () => {
    expect(safeEquals('a', 'aa')).toBe(false);
    expect(safeEquals('', '')).toBe(true);
    expect(safeEquals('abc', 'abc')).toBe(true);
  });
});


describe('vk/signature: судьба `hash` в строке проверки', () => {
  const options = { appId: APP_ID, secretKey: SECRET };

  it('канон (hash не подписан) даёт hashIncluded=false и source=raw', () => {
    const signed = signVkParams(baseParams({ hash: 'inv_0f1e2d3c4b5a' }), options);
    const verified = verifyVkInitDataParams(signed.initData, options);
    expect(verified?.hashIncluded).toBe(false);
    expect(verified?.source).toBe('raw');
  });

  it('подписанный hash принимается вторым проходом — иначе вход ломался бы на приглашённых', () => {
    const signed = signVkParams(baseParams({ hash: 'inv_0f1e2d3c4b5a' }), { ...options, includeHash: true });
    const verified = verifyVkInitDataParams(signed.initData, options);
    expect(verified?.hashIncluded).toBe(true);
    expect(verified?.params['hash']).toBe('inv_0f1e2d3c4b5a');
  });

  it('подменённый hash в подписанной им строке не проходит ни одним проходом', () => {
    const signed = signVkParams(baseParams({ hash: 'inv_0f1e2d3c4b5a' }), { ...options, includeHash: true });
    const tampered = signed.initData.replace('inv_0f1e2d3c4b5a', 'inv_aaaa1111bbbb2222');
    expect(verifyVkInitDataParams(tampered, options)).toBeNull();
  });

  it('без `hash` второй проход не заводится: четыре HMAC вместо восьми', () => {
    const signed = signVkParams(baseParams(), options);
    const diagnosis = diagnoseVkInitData(signed.initData, options);
    expect(diagnosis.hashPresent).toBe(false);
    expect(diagnosis.passes).toHaveLength(4);
    expect(diagnosis.passes.every((pass) => pass.includeHash === false)).toBe(true);
  });
});

describe('vk/signature: диагностика пришедшей подписи', () => {
  const options = { appId: APP_ID, secretKey: SECRET };

  it('форма подписи различает две схемы без знания секрета', () => {
    expect(classifyVkSignShape(signVkMiniApp(baseParams(), APP_ID, SECRET))).toBe('mini_app');
    const launch: VkParams = { vk_app_id: String(APP_ID), vk_ts: '1700000000', vk_user_id: '123456789' };
    expect(classifyVkSignShape(signVkLaunchParams(launch, SECRET))).toBe('launch_params');
    expect(classifyVkSignShape('deadbeef')).toBe('unknown');
    expect(classifyVkSignShape('')).toBe('unknown');
    expect(classifyVkSignShape(null)).toBe('unknown');
  });

  it('отчёт об отказе называет схему по форме, а не по угадыванию', () => {
    // Чужой секрет: подпись по форме — mini_app, совпадений нет ни в одном проходе.
    const foreign = signVkParams(baseParams(), { appId: APP_ID, secretKey: 'attacker-secret' });
    const diagnosis = diagnoseVkInitData(foreign.initData, options);
    expect(diagnosis.signKey).toBe('sign');
    expect(diagnosis.signShape).toBe('mini_app');
    expect(diagnosis.signLength).toBe(64);
    expect(diagnosis.matched).toBeNull();
    expect(diagnosis.passes.some((pass) => pass.matched)).toBe(false);
    expect(diagnosis.paramKeys).toContain('viewer_id');
    expect(diagnosis.paramCount).toBeGreaterThan(0);
  });

  it('в отчёт не попадают значения параметров: только имена', () => {
    const signed = signVkParams(baseParams({ viewer_id: '123456789' }), options);
    const diagnosis = diagnoseVkInitData(signed.initData, options);
    expect(diagnosis.paramKeys.join('&')).not.toContain('123456789');
    expect(JSON.stringify(diagnosis)).not.toContain(SECRET);
    expect(JSON.stringify(diagnosis)).not.toContain(signed.sign);
  });

  it('formatVkPass печатает одну читаемую строку на комбинацию', () => {
    const signed = signVkParams(baseParams({ hash: 'inv_0f1e2d3c4b5a' }), options);
    const diagnosis = diagnoseVkInitData(signed.initData, options);
    expect(formatVkPass(diagnosis.passes[0]!)).toBe('raw/nohash/mini_app=match');
    expect(diagnosis.passes.map(formatVkPass).join('|')).toContain('decoded/nohash/launch_params=miss');
  });
});
