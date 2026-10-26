/**
 * Подтягивает бинарник реального mongod для интеграционных тестов (P5).
 *
 * Зачем отдельный скрипт: `mongodb-memory-server` качает архив MongoDB при
 * ПЕРВОМ запуске, а не при установке пакета. Если это случится внутри vitest,
 * таймаут теста неотличим от таймаута подключения, и падение будет выглядеть как
 * база в сторе. Здесь же скачивание происходит отдельно и один раз, а тесты
 * получают уже разогретый кэш.
 *
 * КАТАЛОГ ЗАДАН АБСОЛЮТНО, и это не косметика: библиотека якорит кэш на ближайший
 * `package.json` с секцией `config`, ища ОТ cwd ВВЕРХ. Прогон из `server/` находит
 * свой кэш, прогон из корня репозитория — нет, и тогда стартует загрузка сотен
 * мегабайт посреди тестов. Один абсолютный путь на оба случая.
 *
 * Каталог лежит в `<репозиторий>/.cache/`, а НЕ в `node_modules/.cache/`: `npm ci`
 * стирает `node_modules` целиком и уносил бы бинарник, превращая каждую чистую
 * установку в гонку «успеет ли тест до конца загрузки MongoDB».
 *
 * Монитор-сервер поднимается и сразу гасится: нужен только факт кэша.
 *
 *   node scripts/mongod-pull.mjs
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MongoMemoryServer } from 'mongodb-memory-server';

const binDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'mongodb-memory-server');

const started = Date.now();
const server = await MongoMemoryServer.create({ binary: { downloadDir: binDir } });
try {
  console.log(`mongod готов: ${server.getUri()}`);
  console.log(`каталог бинарника: ${binDir}`);
  console.log(`разогрето за ${((Date.now() - started) / 1000).toFixed(1)} с`);
} finally {
  await server.stop();
}

