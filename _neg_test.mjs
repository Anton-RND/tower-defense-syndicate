// Негативная проверка самих проверок. Стоп-лист и секция «Терминология» обязаны
// краснеть, если снятый брак вернуть; декоративная охрана хуже отсутствия охраны,
// потому что даёт ложное чувство закрытой темы. Файлы проекта не трогаются: мутится
// копия счётчика, временный файл живёт пару строк и удаляется.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const src = readFileSync('_copy_check.mjs', 'utf8');

const cases = [
  {
    name: 'стоп-лист: в описании снова «чертежами»',
    mutate: (s) => s.replace('возвращается металлами и сырьём для чертежей', 'возвращается чертежами'),
    expect: 'BACK'
  },
  {
    name: 'терминология: в список имён попало «Хроний»',
    mutate: (s) => s.replace("'Вольфрам', 'Станиум']", "'Вольфрам', 'Станиум', 'Хроний']"),
    expect: 'DRIFT'
  },
  {
    name: 'сканер призраков: в него попало живое имя «астерий»',
    mutate: (s) => s.replace("const GHOST_NAMES = ['хроний'];", "const GHOST_NAMES = ['хроний', 'астерий'];"),
    expect: 'DRIFT'
  }
];

let failed = 0;
for (const [i, c] of cases.entries()) {
  const tmp = `_neg_${i}.mjs`;
  writeFileSync(tmp, c.mutate(src), 'utf8');
  const r = spawnSync(process.execPath, [tmp], { encoding: 'utf8' });
  rmSync(tmp, { force: true });
  const out = (r.stdout || '') + (r.stderr || '');
  const hit = out.includes(c.expect);
  const ok = r.status === 1 && hit;
  if (!ok) failed += 1;
  console.log((ok ? 'ПОЙМАНО    ' : 'ПРОПУЩЕНО  ') + c.name +
    '  (exit=' + r.status + ', маркер «' + c.expect + '» ' + (hit ? 'есть' : 'нет') + ')');
}

console.log(failed === 0
  ? '\nвсе ' + cases.length + ' проверки краснеют на возвращённый брак\n'
  : '\nОХРАНА НЕ РАБОТАЕТ: ' + failed + '\n');
process.exit(failed === 0 ? 0 : 1);