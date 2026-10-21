/**
 * meta.suites: инвариант структуры самих тестов.
 *
 * Повод появился реальный: в clan.test.ts потерялся закрывающий `});`, из-за чего два
 * describe легли внутрь тела чужого it. Vitest такие описания не собирает: он не падает,
 * не предупреждает и рисует зелёную галочку. В итоге шесть проверок view- и mongo-слоёв
 * клана не выполнялись, пока остальной файл исправно зелёл. Ни tsc, ни eslint такую
 * конфигурацию не замечают: синтаксически всё корректно, `describe` — обычная функция,
 * вызвать её можно откуда угодно.
 *
 * Отсюда правила, проверяемые здесь по всему каталогу test/:
 *   1. describe/it/test не вызываются из тела теста или хука — такое описание теряется;
 *   2. ни один it/test не висит без describe — иначе бежит без имени набора;
 *   3. в репозитории не остаётся .only и .skip: .only тихо сужает прогон всем остальным,
 *      .skip навсегда выключает проверку без следа. Условные describe.skipIf(условие)
 *      разрешены — они включаются вместе с окружением.
 *
 * Разбор — настоящий AST TypeScript, а не подсчёт скобок: тексты тестов и шаблоны скобок
 * не боятся. И главное: охранитель проверяет сам себя на подброшенном нарушении, иначе
 * его собственная тихая поломка осталась бы незамеченной ровно так же.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Примитивы, чьи описания vitest собирает в дерево прогонов. */
const SUITE_FNS = new Set(['describe', 'it', 'test']);
/** Контексты, внутри которых вложенное описание тоже потеряется. */
const FRAME_FNS = new Set(['it', 'test', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
/** Модификаторы, запрещённые в закоммиченных тестах. */
const BANNED_MODIFIERS = new Set(['only', 'skip']);

type Violation = {
  file: string;
  line: number;
  call: string;
  chain: string[];
  reason: string;
};

/** Заголовок и модификатор вызова: `it.skip(...)` → { head: 'it', modifier: 'skip' }. */
function classify(expr: ts.Node): { head: string; modifier: string | null } | null {
  if (ts.isIdentifier(expr)) return { head: expr.text, modifier: null };
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = classify(expr.expression);
    return inner ? { head: inner.head, modifier: expr.name.text } : null;
  }
  if (ts.isCallExpression(expr)) return classify(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return classify(expr.expression);
  return null;
}

/** Обход одного источника: собирает нарушения структуры с точностью до строки. */
function scanSource(fileName: string, source: string): Violation[] {
  const root = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  function visit(node: ts.Node, chain: string[]): void {
    if (ts.isCallExpression(node)) {
      const info = classify(node.expression);
      if (info && (SUITE_FNS.has(info.head) || FRAME_FNS.has(info.head))) {
        const line = root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1;
        const outer = chain.filter((frame) => frame !== 'describe');
        if (BANNED_MODIFIERS.has(info.modifier ?? '')) {
          report(line, info.head, chain, `модификатор .${info.modifier} выключает часть прогона молча`);
        }
        if (outer.length > 0) {
          report(line, info.head, chain, `описание внутри ${outer[outer.length - 1]} — vitest его не соберёт`);
        }
        if (SUITE_FNS.has(info.head) && info.head !== 'describe' && !chain.includes('describe')) {
          report(line, info.head, chain, 'тест объявлен вне describe — он бежит без имени набора');
        }
        descendArgs(node, [...chain, info.head]);
        return;
      }
    }
    descendAll(node, chain);
  }

  function report(line: number, call: string, chain: string[], reason: string): void {
    violations.push({ file: fileName, line, call, chain: [...chain], reason });
  }

  /**
   * В поддерево callee не спускаемся: `it.each([...])('title', fn)` — это вызов внутри
   * вызова, и иначе каррированная форма выглядела бы как вложенный it с массивом примеров.
   */
  function descendArgs(node: ts.CallExpression, chain: string[]): void {
    for (const arg of node.arguments) visit(arg, chain);
  }

  function descendAll(node: ts.Node, chain: string[]): void {
    ts.forEachChild(node, (child) => visit(child, chain));
  }

  descendAll(root, []);
  return violations;
}

/** Все тестовые файлы каталога (включая подкаталоги, если они когда-нибудь появятся). */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function format(violations: Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line} ${v.call} [${v.chain.join(' > ') || 'file'}] — ${v.reason}`)
    .join('\n');
}

describe('meta/suites: структура тестов как инвариант', () => {
  it('охранитель видит подброшенную вложенность (проверка на самом себе)', () => {
    // Ровно та поломка, из-за которой написан этот файл: describe внутри тела it.
    const planted = scanSource(
      'fixture.phantom.ts',
      [
        "describe('набор', () => {",
        "  it('тест', () => {",
        "    describe('потерянный набор', () => {",
        "      it('потерянный тест', () => { expect(1).toBe(1); });",
        '    });',
        '  });',
        '});',
        ''
      ].join('\n')
    );
    expect(planted.map((v) => `${v.line}:${v.call}`)).toEqual(['3:describe', '4:it']);
  });

  it('охранитель видит тест без набора и запрещённые модификаторы', () => {
    expect(scanSource('fixture.orphan.ts', "it('сирота', () => {});").map((v) => v.line)).toEqual([1]);
    const only = scanSource('fixture.only.ts', "describe('н', () => {\n  it.only('т', () => {});\n});");
    expect(only.some((v) => v.reason.includes('.only'))).toBe(true);
    // Условные наборы допустимы: они включаются вместе с окружением.
    expect(scanSource('fixture.skipif.ts', "describe.skipIf(!process.env.X)('н', () => {});")).toEqual([]);
    // Каррированный it.each([...])('title', fn) — не вложенный it (проверка на собственный
    // ложный позитив: callee у такого вызова сам является вызовом).
    const each = scanSource(
      'fixture.each.ts',
      ["describe('н', () => {", "  it.each([", "    ['а']", "  ])('%s', () => { expect(1).toBe(1); });", "  it.skipIf(false)('т', () => {});", '});'].join('\n')
    );
    expect(format(each)).toBe('');
  });

  it('ни один набор не вложен в тело теста и ни один тест не висит без набора', () => {
    const files = testFiles(TEST_DIR);
    expect(files.length).toBeGreaterThan(30);
    const violations = files.flatMap((full) =>
      scanSource(path.relative(TEST_DIR, full), readFileSync(full, 'utf8'))
    );
    expect(format(violations)).toBe('');
  });
});
