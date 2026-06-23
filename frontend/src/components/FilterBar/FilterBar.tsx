import type { ReactNode } from 'react';
import { catRu } from '../../utils/category';
import styles from './FilterBar.module.css';

export interface FilterBarProps {
  search: string;
  onSearch: (v: string) => void;
  /** коды категорий (отрисуются на русском); если не заданы — селект не показывается */
  categories?: string[];
  category?: string;
  onCategory?: (v: string) => void;
  /** если задан onGroup — показываем кнопку «Группировка» */
  group?: boolean;
  onGroup?: () => void;
  /** доп. контролы справа (chip-кнопки конкретной страницы) */
  children?: ReactNode;
}

/** Единый ряд фильтров: поиск + «Все категории» + «Группировка» (+ доп. кнопки). */
export function FilterBar({
  search, onSearch, categories, category = '', onCategory, group, onGroup, children,
}: FilterBarProps) {
  return (
    <div className={styles.bar}>
      <input
        className={styles.search}
        placeholder="Поиск по SKU или названию…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {categories && onCategory && (
        <select className={styles.select} value={category} onChange={(e) => onCategory(e.target.value)}>
          <option value="">Все категории</option>
          {categories.map((c) => <option key={c} value={c}>{catRu(c)}</option>)}
        </select>
      )}
      {onGroup && (
        <button type="button" className={`${styles.chip} ${group ? styles.chipOn : ''}`} onClick={onGroup}>
          {group ? '✓ Группировка' : 'Группировка'}
        </button>
      )}
      {children}
    </div>
  );
}

/** Стиль chip-кнопки FilterBar — чтобы доп. кнопки страниц выглядели одинаково. */
export const filterChip = (on: boolean): string => `${styles.chip} ${on ? styles.chipOn : ''}`;
