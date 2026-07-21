// Категории Kaspi: англ. коды мастер-категорий → русские названия.
// Единый источник для всех страниц (дашборд, юнит, план).
const CAT_RU: Record<string, string> = {
  'Master - Smartphones screen protection': 'Защитные стёкла',
  'Master - Headphones': 'Наушники',
  'Master - Wireless chargers': 'Беспроводные зарядки',
  'Master - Camping flashlights': 'Фонари',
  'Master - Surge protectors': 'Сетевые фильтры',
  'Master - Phone holders': 'Держатели для телефона',
  'Master - USB Flash drives': 'USB-флешки',
  'Master - Power banks': 'Power bank',
  'Master - Portable speakers': 'Портативные колонки',
  'Master - Memory cards': 'Карты памяти',
  'Master - Mice': 'Мыши',
  'Master - Mouse pads': 'Коврики для мыши',
  'Master - Security cameras': 'Камеры видеонаблюдения',
  'Master - Cables and adapters': 'Кабели и переходники',
  'Master - Microphones': 'Микрофоны',
  'Master - Smart watches': 'Смарт-часы',
  'Master - Chargers and starters for batteries': 'Зарядные устройства',
  'Master - Computer cables and adapters': 'Компьютерные кабели',
  'Master - DVRs': 'Видеорегистраторы',
  'Master - Wireless equipment': 'Беспроводное оборудование',
};

/** Англ. код категории Kaspi → русское название (фолбэк: убрать префикс «Master - »). */
export const catRu = (c: string | null | undefined): string => {
  if (!c) return '—';
  return CAT_RU[c] ?? (c.replace(/^Master - /, '') || '—');
};
