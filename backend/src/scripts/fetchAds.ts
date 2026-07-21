/**
 * Автозагрузка рекламных отчётов из кабинета Kaspi Marketing.
 *   npx tsx src/scripts/fetchAds.ts [YYYY-MM-DD]
 *
 * Публичный Shop API рекламу не отдаёт, но у кабинета marketing.kaspi.kz есть
 * приватный API (авторизация — по куке X-Kb-Session-Id, а не по API-токену):
 *   • v5 …/Campaigns?StartDate=…&EndDate=…&state=Enabled — список активных кампаний
 *     с их id (получаем сами, поэтому конфиг с id не нужен: новую кампанию в
 *     кабинете скрипт подхватит автоматически);
 *   • v3 …/reports/products/csv?campaignId=…&startDate=…&endDate=… — тот же CSV
 *     «Отчёт по товарам», что скачивается кнопкой вручную.
 *
 * Для каждой активной кампании тянем отчёт за день (по умолчанию — вчера по
 * Алматы) и сохраняем в data/ под именем, которое понимает importAds.ts. Затем:
 *   npx tsx src/scripts/importAds.ts   — сложит всё в ad_spend с дневным ДРР.
 *
 * Файлы за один день кладутся с одинаковым периодом в имени, importAds сам
 * суммирует кампании по товару. Сессия живёт ограниченно: при 401/403 скрипт
 * останавливается и просит обновить куку из браузера.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, '../../../.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  if (!(line.slice(0, i).trim() in process.env)) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const MERCHANT = process.env.KASPI_MERCHANT_ID;
const SESSION = process.env.KASPI_MARKETING_SESSION;
if (!MERCHANT || !SESSION) {
  console.error('[fetchAds] нет KASPI_MERCHANT_ID / KASPI_MARKETING_SESSION в .env');
  process.exit(1);
}

const DATA_DIR = join(here, '../../../data');
const API = 'https://marketing.kaspi.kz/advertising/products/api';

/** «Вчера» по Алматы (+05): отчёт за завершившийся день. */
const ALMATY_OFFSET_MS = 5 * 3_600_000;
const almatyYesterday = (): string =>
  new Date(Date.now() + ALMATY_OFFSET_MS - 86_400_000).toISOString().slice(0, 10);

const argDate = process.argv[2];
if (argDate && !/^\d{4}-\d{2}-\d{2}$/.test(argDate)) {
  console.error(`[fetchAds] дата должна быть YYYY-MM-DD, получено "${argDate}"`);
  process.exit(1);
}
const date = argDate ?? almatyYesterday();

const HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Front-Version': '5.0.496',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Cookie: `X-Kb-Session-Id=${SESSION}; KB_SPECIAL_USER=42; locale=ru-RU`,
};

/** Ловим протухшую сессию единообразно: без валидной куки автоматизировать нечего. */
function dieIfUnauthorized(status: number, where: string): void {
  if (status === 401 || status === 403) {
    console.error(`\n[fetchAds] ${status} на «${where}» — сессия недействительна.`);
    console.error('[fetchAds] Обнови X-Kb-Session-Id в .env из браузера (залогинься в marketing.kaspi.kz) и запусти снова.');
    process.exit(2);
  }
}

/** Убираем из имени кампании символы, недопустимые в имени файла Windows. */
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Campaign { id: number; name: string; }

// ── 1. Список активных кампаний за день (v5) ─────────────────────────────────
const listUrl = `${API}/v5/merchant/${MERCHANT}/Campaigns?StartDate=${date}&EndDate=${date}&state=Enabled`;
let listRes: Response;
try {
  listRes = await fetch(listUrl, { headers: { ...HEADERS, Referer: 'https://marketing.kaspi.kz/advertising/campaigns?tab=campaigns' } });
} catch (e) {
  console.error(`[fetchAds] не достучались до кабинета: ${(e as Error).message}`);
  process.exit(1);
}
dieIfUnauthorized(listRes.status, 'список кампаний');
if (!listRes.ok) {
  console.error(`[fetchAds] список кампаний: HTTP ${listRes.status}`);
  process.exit(1);
}
const listJson = (await listRes.json()) as { data?: Array<{ id: number; name: string }> };
const campaigns: Campaign[] = (listJson.data ?? [])
  .filter((c) => c.id && c.name)
  .map((c) => ({ id: c.id, name: c.name }));
if (campaigns.length === 0) {
  console.error('[fetchAds] кабинет вернул пустой список активных кампаний — проверь куку/дату');
  process.exit(1);
}
console.log(`[fetchAds] merchant ${MERCHANT}, дата ${date}, активных кампаний ${campaigns.length}`);

// ── 2. По каждой кампании — CSV «Отчёт по товарам» (v3) ───────────────────────
let ok = 0, failed = 0;
for (const c of campaigns) {
  const url = `${API}/v3/merchant/${MERCHANT}/reports/products/csv`
    + `?campaignId=${c.id}&startDate=${date}&endDate=${date}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...HEADERS, Accept: 'text/csv,*/*', Referer: `https://marketing.kaspi.kz/advertising/campaigns/${c.id}` } });
  } catch (e) {
    console.error(`  ! ${c.name} (${c.id}): сеть — ${(e as Error).message}`);
    failed++;
    continue;
  }
  dieIfUnauthorized(res.status, `отчёт ${c.name}`);
  if (!res.ok) {
    console.error(`  ! ${c.name} (${c.id}): HTTP ${res.status}`);
    failed++;
    continue;
  }

  const csv = await res.text();
  const rows = Math.max(csv.split(/\r?\n/).filter((l) => l.trim()).length - 1, 0); // минус заголовок
  const file = join(DATA_DIR, `${date} - ${date} ${safeName(c.name)} Отчёт по товарам.csv`);
  writeFileSync(file, csv, 'utf8');
  console.log(`  ✓ ${c.name}: строк ${rows}`);
  ok++;
  await sleep(250); // вежливая пауза между запросами
}

console.log(`[fetchAds] ГОТОВО: скачано ${ok}/${campaigns.length}, ошибок ${failed}. Дальше: npx tsx src/scripts/importAds.ts`);
if (failed > 0) process.exit(1);
