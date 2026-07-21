/**
 * Диагностика: сколько живёт сессия кабинета и продлевают ли её наши запросы.
 *   npx tsx src/scripts/probeSession.ts [минут] [интервал_сек]
 *
 * Зачем: обе куки (реклама и кабинет) умирают за минуты, а не за сутки, и из-за
 * этого ночной прогон в 00:00 не имеет шансов. Прежде чем что-то строить, надо
 * понять ПОЧЕМУ. Скрипт долбит самый дешёвый эндпоинт (count) с интервалом и пишет:
 *   • статус — когда именно наступает 401;
 *   • Set-Cookie — не ротирует ли Kaspi сессию (тогда надо ходить по цепочке).
 *
 * Ответ читаем так:
 *   401 сразу      → кука уже мертва, дай свежую;
 *   401 через N мин при БЕЗДЕЙСТВИИ браузера → это idle-таймаут, и наши запросы
 *                    его НЕ продлевают → нужен либо автологин, либо ручной прогон;
 *   живёт, пока пингуем → keep-alive решает задачу: пингуем раз в N мин и ночной
 *                    прогон застаёт живую сессию.
 */
const COOKIE = process.env.KASPI_MC_COOKIE;
const MERCHANT = process.env.KASPI_MC_MERCHANT_ID;
if (!COOKIE || !MERCHANT) {
  // .env читаем сами — скрипт запускается с хоста
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const line of readFileSync(join(here, '../../../.env'), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    if (!(line.slice(0, i).trim() in process.env)) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
const C = process.env.KASPI_MC_COOKIE!;
const M = process.env.KASPI_MC_MERCHANT_ID!;

const minutes = Number(process.argv[2] ?? 30);
const everySec = Number(process.argv[3] ?? 60);

// UA берём тот же, что в браузере при снятии куки: если Kaspi привязывает сессию
// к устройству, чужой UA — сам по себе причина 401.
const UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

const H: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9',
  origin: 'https://kaspi.kz',
  referer: 'https://kaspi.kz/',
  'user-agent': UA,
  'x-auth-version': '3',
  cookie: C,
};

const started = Date.now();
const deadline = started + minutes * 60_000;
console.log(`[probe] пингуем count?m=${M} каждые ${everySec}с в течение ${minutes} мин`);
console.log(`[probe] UA: Android Pixel 9 (как в браузере при снятии куки)\n`);

let n = 0;
while (Date.now() < deadline) {
  n++;
  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  let line = `[probe] +${mins.padStart(5)} мин  #${String(n).padStart(3)}  `;
  try {
    const r = await fetch(`https://mc.shop.kaspi.kz/bff/offer-view/count?m=${M}`, { headers: H });
    line += `HTTP ${r.status}`;
    const sc = r.headers.get('set-cookie');
    if (sc) line += `  Set-Cookie: ${sc.slice(0, 120)}`;
    if (r.ok) line += `  ${(await r.text()).slice(0, 80)}`;
    else if (r.status === 401 || r.status === 403) {
      console.log(line);
      console.log(`\n[probe] ВЫВОД: сессия умерла через ${mins} мин после старта пробы.`);
      console.log('[probe] Наши запросы её НЕ продлевают — keep-alive не спасёт, нужен автологин или ручной прогон.');
      break;
    }
  } catch (e) {
    line += `сеть: ${(e as Error).message}`;
  }
  console.log(line);
  await new Promise((s) => setTimeout(s, everySec * 1000));
}
if (Date.now() >= deadline) {
  console.log(`\n[probe] ВЫВОД: сессия ПРОЖИЛА все ${minutes} мин под нашими пингами.`);
  console.log('[probe] Значит keep-alive работает: пингуем раз в N мин — и ночной прогон застаёт живую сессию.');
}
