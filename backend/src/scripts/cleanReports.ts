/**
 * Уборка скачанных рекламных отчётов из data/.
 *   npx tsx src/scripts/cleanReports.ts [дней]   (по умолчанию 1)
 *
 * fetchAds качает по файлу на кампанию — 19 штук в день, и data/ быстро зарастает.
 * Данные из них уже лежат в ad_spend (importAds), так что файлы — временные.
 * Удаляем только отчёты СТАРШЕ N дней и только те, что качает fetchAds: ручные
 * выгрузки («Обзорный отчёт», «Отчёт по кампаниям»), лог и xlsx остаются.
 *
 * Вызывается из sync-ads.ps1 ТОЛЬКО после успешного импорта: если импорт упал,
 * файлы — единственная копия данных, и терять их нельзя.
 *
 * Живёт отдельным скриптом, а не внутри importAds, чтобы ручной прогон импорта
 * ничего не удалял, и не внутри .ps1 — PowerShell 5.1 читает .ps1 без BOM как
 * cp1251 и ломается о кириллицу в маске имени.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '../../../data');

const arg = process.argv[2];
const days = arg ? Number(arg) : 1;
if (!Number.isFinite(days) || days < 0) {
  console.error(`[clean] дней должно быть числом >= 0, получено "${arg}"`);
  process.exit(1);
}

const cutoff = Date.now() - days * 86_400_000;
const files = readdirSync(DATA_DIR).filter((f) => f.includes('Отчёт по товарам') && f.endsWith('.csv'));

let removed = 0, kept = 0;
for (const f of files) {
  const p = join(DATA_DIR, f);
  if (statSync(p).mtimeMs < cutoff) {
    unlinkSync(p);
    removed++;
  } else {
    kept++;
  }
}
console.log(`[clean] отчётов удалено ${removed}, оставлено ${kept} (порог ${days} дн)`);
