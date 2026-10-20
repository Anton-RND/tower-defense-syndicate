import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Игровая страница полигона (`/play`).
 *
 * Это первый слой отрисовки в проекте: до него существовал только `debug.html` —
 * пульт форм и таблиц, где планировку базы нельзя было даже увидеть. Модуль
 * повторяет приём debugPage целиком, включая причину: HTML лежит рядом отдельным
 * файлом, правится без перекомпиляции TypeScript и не может сломать сборку
 * незакрытым шаблонным литералом.
 *
 * `tsc` не копирует посторонние файлы в dist — отсюда второй кандидат пути. При
 * запуске из исходников (tsx) срабатывает первый, из сборки — второй.
 *
 * Страница сознательно не собирается: ни bundler, ни рантайм-зависимостей во фронте
 * монорепо нет (frontend/ — только адаптеры площадки). Вся геометрия и правила
 * приходят из `GET /v1/config`, боевые цифры — из ответа рейда, поэтому ни одна
 * константа баланса здесь не продублирована.
 *
 * Кэш снимается один раз на процесс: правку play.html нужно переживать перезапуском
 * dev-сервера. tsx watch следит за .ts, поэтому этот комментарий — законный способ
 * заставить стенд перечитать HTML.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [path.resolve(here, 'play.html'), path.resolve(here, '..', '..', 'src', 'http', 'play.html')];

let cached: string | null = null;

export function loadPlayPage(): string {
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
    '<!doctype html><meta charset="utf-8"><title>Полигон не найден</title>' +
    '<p style="font:14px monospace;padding:24px">Не найден <code>server/src/http/play.html</code>. ' +
    'При запуске из сборки положите его рядом с <code>dist/http/</code>.</p>';
  return cached;
}
