import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Отладочная страница стенда.
 *
 * HTML живёт рядом отдельным файлом, а не строкой в этом модуле, по двум причинам:
 * его можно править без перекомпиляции TypeScript, и в нём нет ни единого шанса
 * сломать сборку незакрытым шаблонным литералом.
 *
 * `tsc` не копирует посторонние файлы в dist — отсюда второй кандидат пути. При
 * запуске из исходников (tsx) срабатывает первый, из сборки — второй.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [path.resolve(here, 'debug.html'), path.resolve(here, '..', '..', 'src', 'http', 'debug.html')];

let cached: string | null = null;

export function loadDebugPage(): string {
  if (cached) return cached;
  for (const candidate of CANDIDATES) {
    try {
      cached = readFileSync(candidate, 'utf8');
      return cached;
    } catch {
      // Пробуем следующий: отсутствие файла в одном из двух layout'ей — норма.
    }
  }
  cached =
    '<!doctype html><meta charset="utf-8"><title>Стенд не найден</title>' +
    '<p style="font:14px monospace;padding:24px">Не найден <code>server/src/http/debug.html</code>. ' +
    'При запуске из сборки положите его рядом с <code>dist/http/</code>.</p>';
  return cached;
}
