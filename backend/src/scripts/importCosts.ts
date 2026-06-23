/**
 * Импорт себестоимости из data/Book1*.xlsx (закуп ¥ + курс).
 * В файле нет артикулов — только коды моделей (FK330, FH300, U56 64…).
 * Матчим по коду: все токены кода должны встречаться в названии товара
 * как отдельные «слова» (\b…\b), берём самый специфичный код.
 *   npx tsx src/scripts/importCosts.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, '../../../.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  if (!(line.slice(0, i).trim() in process.env)) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
process.env.DATABASE_URL = 'postgres://kaspi_user:kaspi_pass@localhost:5433/kaspi_rnp';
const { query, closePool } = await import('../db/pool.js');

const dataDir = join(here, '../../../data');
const file = readdirSync(dataDir).find((f) => /^Book1/i.test(f) && /\.xlsx/i.test(f));
if (!file) { console.log('Book1*.xlsx не найден в data/'); process.exit(1); }
console.log('[cogs] файл:', file);

const wb = XLSX.read(readFileSync(join(dataDir, file)));
const ws = wb.Sheets[wb.SheetNames[0]!]!;
const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, raw: true, defval: '' });
const header = (aoa[0] ?? []).map((x) => String(x ?? '').toUpperCase().trim());
const iZ = header.findIndex((h) => h.includes('ЗАКУП'));
const iK = header.findIndex((h) => h.includes('КУРС'));
const iD = header.findIndex((h) => h.includes('ДОСТАВ')); // доставка из Китая, ₸/шт

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// числовой токен: не за ним другая цифра (32 ≠ 320), но единица можно (32GB, 32ГБ).
// буквенный токен: не за ним буква (FAIZ ≠ FAIZFULL), но цифра можно (FAIZ164).
const tokenRegex = (t: string): RegExp =>
  new RegExp(`\\b${esc(t)}${/^\d+$/.test(t) ? '(?![0-9])' : '(?![A-Za-z])'}`, 'i');
interface Code { code: string; zakup: number; kurs: number; china: number; regs: RegExp[] }
const codes: Code[] = [];
for (const row of aoa.slice(1)) {
  const name = String(row[0] ?? '').trim();
  const z = Number(row[iZ]);
  if (!name || !Number.isFinite(z) || z <= 0) continue; // пропуск заголовков-категорий/пустых
  const toks = name.toUpperCase().split(/\s+/).filter(Boolean);
  const china = iD >= 0 ? Number(row[iD]) : 0;
  codes.push({ code: name, zakup: z, kurs: Number(row[iK]) || 78, china: Number.isFinite(china) ? china : 0, regs: toks.map(tokenRegex) });
}
console.log('[cogs] кодов с закупом в файле:', codes.length);

const fxRow = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_cny'`);
const fx = fxRow[0] ? Number(fxRow[0].value) : 78;

const products = await query<{ sku: string; name: string }>(`SELECT sku, name FROM sku`);

const matched: { sku: string; name: string; code: string; zakup: number; china: number }[] = [];
const unmatched: string[] = [];
const usedCodes = new Set<string>();
for (const p of products) {
  let best: Code | null = null, bestScore = 0;
  for (const c of codes) {
    if (c.regs.every((r) => r.test(p.name))) {
      const score = c.regs.length * 1000 + c.code.length;
      if (score > bestScore) { best = c; bestScore = score; }
    }
  }
  if (best) { matched.push({ sku: p.sku, name: p.name, code: best.code, zakup: best.zakup, china: best.china }); usedCodes.add(best.code); }
  else unmatched.push(p.name);
}

console.log(`\n[cogs] сопоставлено: ${matched.length} из ${products.length} товаров`);
console.log('--- примеры матчей ---');
matched.slice(0, 15).forEach((m) => console.log(`  «${m.code}» → ${m.name.slice(0, 45)} (закуп ${m.zakup}¥ → ${Math.round(m.zakup * fx)}₸)`));
console.log(`\n--- НЕ сопоставлены (${unmatched.length}) ---`);
unmatched.slice(0, 30).forEach((n) => console.log('  ?', n.slice(0, 55)));

// запись
for (const m of matched) {
  await query(
    `INSERT INTO sku_costs (sku, cogs, cogs_yuan, china_delivery, packaging, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT packaging FROM sku_costs WHERE sku = $1), 0), now())
     ON CONFLICT (sku) DO UPDATE SET cogs = EXCLUDED.cogs, cogs_yuan = EXCLUDED.cogs_yuan,
       china_delivery = EXCLUDED.china_delivery, updated_at = now()`,
    [m.sku, Math.round(m.zakup * fx), m.zakup, Math.round(m.china)],
  );
}
const withChina = matched.filter((m) => m.china > 0).length;
console.log(`\n[cogs] ГОТОВО: записано ${matched.length}, курс ${fx}, с доставкой Китая ${withChina}`);
await closePool();
