/** Список месяцев для селекторов периода. */

const ALMATY_OFFSET_MS = 5 * 3_600_000; // +05

/** Текущий месяц в Asia/Almaty: 'YYYY-MM'. */
export function currentMonth(): string {
  return new Date(Date.now() + ALMATY_OFFSET_MS).toISOString().slice(0, 7);
}

/**
 * Последние `count` месяцев, начиная с текущего, по убыванию:
 * ['2026-07', '2026-06', '2026-05'].
 */
export function recentMonths(count = 6): string[] {
  const now = new Date(Date.now() + ALMATY_OFFSET_MS);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11

  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - i, 1));
    return d.toISOString().slice(0, 7);
  });
}
