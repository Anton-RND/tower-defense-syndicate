/**
 * Подтягивает бинарник реального mongod для интеграционных тестов (P5).
 *
 * Зачем отдельный скрипт: `mongodb-memory-server` качает ~100 МБ архив MongoDB при
 * ПЕРВОМ запуске, а не при установке пакета. Если это случится внутри vitest,
 * таймаут теста неотличим от таймаута подключения, и падение будет выглядеть как
 * база в сторе. Здесь же скачивание происходит отдельно и один раз, а тесты
 * получают уже разогретый кэш (`~/.cache/mongodb-binaries`).
 *
 * Мониторинг-сервер поднимается и сразу гасится: нужен только факт кэша.
 *
 *   node scripts/mongod-pull.mjs
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const started = Date.now();
const server = await MongoMemoryServer.create();
try {
  console.log(`mongod готов: ${server.getUri()}`);
  console.log(`бинарник разогрет за ${((Date.now() - started) / 1000).toFixed(1)} с`);
} finally {
  await server.stop();
}
