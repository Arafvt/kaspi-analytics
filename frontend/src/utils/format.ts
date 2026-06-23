/** Форматтеры чисел: тенге, проценты, штуки (раздел 9 ТЗ). */

const nf = new Intl.NumberFormat('ru-RU');

/** 1234567 -> "1 234 567 ₸" */
export function tenge(v: number): string {
  return `${nf.format(Math.round(v))} ₸`;
}

/** 0.125 -> "12.5%" */
export function percent(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** 9075 -> "9 075 шт" */
export function qty(v: number): string {
  return `${nf.format(v)} шт`;
}

/** Цвет индикации маржи: зелёный/жёлтый/красный. */
export function marginLevel(margin: number): 'good' | 'warn' | 'bad' {
  if (margin >= 0.2) return 'good';
  if (margin >= 0.1) return 'warn';
  return 'bad';
}
