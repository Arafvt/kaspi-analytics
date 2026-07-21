import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { rnpApi, costsApi } from '../../api/rnp';
import { tenge, percent, qty, marginLevel } from '../../utils/format';
import { catRu } from '../../utils/category';
import { FilterBar, filterChip } from '../../components/FilterBar/FilterBar';
import type { UnitRow } from '../../types/rnp';
import { currentMonth } from '../../utils/months';
import styles from './UnitPage.module.css';

const PERIOD = currentMonth();
const nf = new Intl.NumberFormat('ru-RU');
const div = (a: number, b: number) => (b ? a / b : 0);

// матчинг кода модели в названии товара (как в importCosts): \b + границы цифр/букв
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenRegex = (t: string) => new RegExp(`\\b${escRe(t)}${/^\d+$/.test(t) ? '(?![0-9])' : '(?![A-Za-z])'}`, 'i');

type Kind = 'money' | 'qty' | 'count' | 'ratio' | 'yuan' | 'rate' | 'weight' | 'usd';
type Mode = 'total' | 'unit' | 'pct';
interface Col {
  key: string;
  label: string;
  kind: Kind;
  get: (r: UnitRow) => number;
  noPct?: boolean;   // нет режима % (выручка, ср.клик)
  noUnit?: boolean;  // нет режима «за 1 шт» (ср.клик)
  adOnly?: boolean;
  color?: 'margin' | 'profit';
  edit?: 'yuan' | 'fx' | 'usd' | 'weight' | 'perkg' | 'pack';  // редактируемое поле
}
const canPct = (c: Col) => c.kind === 'money' && !c.noPct;
const canUnit = (c: Col) => c.kind === 'money' && !c.noUnit;
const hasToggle = (c: Col) => c.kind === 'money' && (canPct(c) || canUnit(c));
interface Block { name: string; cols: Col[] }

const BLOCKS: Block[] = [
  { name: 'Продажи', cols: [
    { key: 'revenue', label: 'Выручка', kind: 'money', noPct: true, get: (r) => r.revenue },
    { key: 'units', label: 'Продано', kind: 'qty', get: (r) => r.units },
    { key: 'cancelPct', label: '% отмен', kind: 'ratio', get: (r) => r.cancelPct },
    { key: 'returnPct', label: '% возвр.', kind: 'ratio', get: (r) => r.returnPct },
    { key: 'creditShare', label: 'Рассрочка', kind: 'ratio', get: (r) => r.creditShare },
  ] },
  { name: 'Расходы', cols: [
    { key: 'commission', label: 'Комиссия', kind: 'money', get: (r) => r.commission },
    { key: 'creditUplift', label: 'Надбавка', kind: 'money', get: (r) => r.creditUplift },
    { key: 'delivery', label: 'Доставка', kind: 'money', get: (r) => r.delivery },
    { key: 'tax', label: 'Налог', kind: 'money', get: (r) => r.tax },
  ] },
  { name: 'Закупка / себестоимость', cols: [
    { key: 'cogsYuan', label: 'Закуп ¥', kind: 'yuan', edit: 'yuan', get: (r) => r.cogsYuan },
    { key: 'fxRate', label: 'Курс ¥', kind: 'rate', edit: 'fx', get: (r) => r.fxRate },
    { key: 'cogsNoDeliv', label: 'Себест. без дост.', kind: 'money', get: (r) => r.cogsNoDeliv },
    { key: 'weight', label: 'Вес, кг', kind: 'weight', edit: 'weight', get: (r) => r.weight },
    { key: 'deliveryPerKg', label: 'Дост. за кг $', kind: 'usd', edit: 'perkg', get: (r) => r.deliveryPerKg },
    { key: 'usdRate', label: 'Курс $', kind: 'rate', edit: 'usd', get: (r) => r.usdRate },
    { key: 'chinaDelivery', label: 'Доставка Китай', kind: 'money', get: (r) => r.chinaDelivery },
    { key: 'packaging', label: 'Упаковка', kind: 'money', edit: 'pack', get: (r) => r.packagingTotal },
    { key: 'cogsTotal', label: 'Себест. с дост.', kind: 'money', get: (r) => r.cogsTotal },
  ] },
  { name: 'Реклама', cols: [
    { key: 'adSpend', label: 'Реклама', kind: 'money', get: (r) => r.adSpend },
    { key: 'adViews', label: 'Просмотры', kind: 'count', adOnly: true, get: (r) => r.adViews },
    { key: 'adClicks', label: 'Клики', kind: 'count', adOnly: true, get: (r) => r.adClicks },
    { key: 'cpc', label: 'Ср. клик', kind: 'money', noPct: true, noUnit: true, adOnly: true, get: (r) => div(r.adSpend, r.adClicks) },
    { key: 'ctr', label: 'CTR', kind: 'ratio', adOnly: true, get: (r) => r.ctr },
    { key: 'conversion', label: 'Конверсия', kind: 'ratio', adOnly: true, get: (r) => r.conversion },
    { key: 'drr', label: 'ДРР', kind: 'ratio', get: (r) => r.drr },
  ] },
  { name: 'Финансы (с ДРР)', cols: [
    { key: 'marginNoAds', label: 'Маржа до ДРР', kind: 'ratio', color: 'margin', get: (r) => r.marginNoAds },
    { key: 'marginWAds', label: 'Маржа с ДРР', kind: 'ratio', color: 'margin', get: (r) => r.marginWAds },
    { key: 'profit', label: 'Прибыль', kind: 'money', color: 'profit', get: (r) => r.profit },
    { key: 'roi', label: 'ROI', kind: 'ratio', get: (r) => r.roi },
    { key: 'payout', label: 'Выплата', kind: 'money', get: (r) => r.payout },
  ] },
];
const FLAT = BLOCKS.flatMap((b) => b.cols);
const TOTAL_COLS = 3 + FLAT.length; // Фото + Артикул + Название + числовые

function adMissing(c: Col, r: UnitRow): boolean {
  if (!c.adOnly) return false;
  if (c.key === 'conversion' || c.key === 'cpc') return r.adClicks === 0;
  return r.adViews === 0;
}
/** число в «отображаемых» единицах (для порогов и форматирования) */
function cellNumber(c: Col, r: UnitRow, mode: Mode): number {
  const v = c.get(r);
  if (c.kind === 'ratio') return v * 100;
  if (c.kind === 'money') {
    if (mode === 'pct' && !c.noPct) return div(v, r.revenue) * 100;
    if (mode === 'unit' && !c.noUnit) return div(v, r.units);
  }
  return v;
}
function cellText(c: Col, r: UnitRow, mode: Mode): string {
  if (adMissing(c, r)) return '—';
  const v = c.get(r);
  if (c.kind === 'ratio') return percent(v);
  if (c.kind === 'count') return nf.format(Math.round(v));
  if (c.kind === 'qty') return qty(v);
  if (c.kind === 'yuan') return v > 0 ? `${Math.round(v * 100) / 100} ¥` : '—';
  if (c.kind === 'weight') return v > 0 ? `${Math.round(v * 1000) / 1000} кг` : '—';
  if (c.kind === 'usd') return v > 0 ? `${Math.round(v * 100) / 100} $` : '—';
  if (c.kind === 'rate') return v > 0 ? nf.format(v) : '—';
  if (mode === 'pct' && !c.noPct) return percent(div(v, r.revenue));
  if (mode === 'unit' && !c.noUnit) return tenge(div(v, r.units));
  return tenge(v);
}

type Rule = { green: number | null; red: number | null };
type FilterCond = { id: number; key: string; op: '>=' | '<='; value: string };

export function UnitPage() {
  const [rows, setRows] = useState<UnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [group, setGroup] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (cat: string) => setCollapsed((s) => {
    const n = new Set(s); if (n.has(cat)) n.delete(cat); else n.add(cat); return n;
  });
  const [colMode, setColMode] = useState<Record<string, Mode>>({});
  const [allMode, setAllMode] = useState<Mode>('total');
  const [edit, setEdit] = useState<{ sku: string; key: string } | null>(null);
  const [editVal, setEditVal] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [showThresholds, setShowThresholds] = useState(false);
  const [rules, setRules] = useState<Record<string, Rule>>(() => {
    try { return JSON.parse(localStorage.getItem('unit_rules') ?? '{}'); } catch { return {}; }
  });
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterCond[]>(() => {
    try { return JSON.parse(localStorage.getItem('unit_filters') ?? '[]'); } catch { return []; }
  });
  const [importMsg, setImportMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    rnpApi.unit(PERIOD).then((res) => setRows(res.items)).catch(() => setRows([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const saveRules = (r: Record<string, Rule>) => {
    setRules(r);
    localStorage.setItem('unit_rules', JSON.stringify(r));
  };

  const saveFilters = (f: FilterCond[]) => {
    setFilters(f);
    localStorage.setItem('unit_filters', JSON.stringify(f));
  };
  const addFilter = () => saveFilters([...filters, { id: Math.max(0, ...filters.map((x) => x.id)) + 1, key: 'marginWAds', op: '>=', value: '' }]);
  const updFilter = (id: number, patch: Partial<FilterCond>) => saveFilters(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const delFilter = (id: number) => saveFilters(filters.filter((f) => f.id !== id));
  const activeFilters = filters.filter((f) => f.value !== '').length;

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category))].sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (category && r.category !== category) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.sku.includes(q)) return false;
      // умные фильтры: показываем только товары, проходящие ВСЕ условия
      for (const f of filters) {
        if (f.value === '') continue;
        const col = FLAT.find((c) => c.key === f.key);
        if (!col) continue;
        const target = Number(String(f.value).replace(',', '.'));
        if (!Number.isFinite(target)) continue;
        const v = cellNumber(col, r, 'total'); // ₸ для денег, % для долей
        if (f.op === '>=' ? v < target : v > target) return false;
      }
      return true;
    });
    if (sort) {
      const sv = (r: UnitRow): number | string => {
        if (sort.key === 'name') return r.name;
        if (sort.key === 'article') return r.sku;
        return FLAT.find((c) => c.key === sort.key)?.get(r) ?? 0;
      };
      list.sort((a, b) => {
        const x = sv(a), y = sv(b);
        const cmp = typeof x === 'number' && typeof y === 'number'
          ? x - y : String(x).localeCompare(String(y));
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [rows, search, category, sort, filters]);

  const groups = useMemo(() => {
    if (!group) return null;
    const map = new Map<string, UnitRow[]>();
    for (const r of filtered) { const a = map.get(r.category) ?? []; a.push(r); map.set(r.category, a); }
    return [...map.entries()]
      .map(([cat, items]) => ({ cat, items, revenue: items.reduce((s, x) => s + x.revenue, 0), profit: items.reduce((s, x) => s + x.profit, 0) }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [filtered, group]);

  const clickSort = (key: string) => {
    setSort((s) => {
      if (s?.key !== key) return { key, dir: 'desc' };
      if (s.dir === 'desc') return { key, dir: 'asc' };
      return null;
    });
  };
  const arrow = (key: string) => (sort?.key === key ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '');

  const modeOf = (c: Col): Mode => (c.kind === 'money' ? (colMode[c.key] ?? 'total') : 'total');
  const badge = (c: Col) => { const m = modeOf(c); return m === 'pct' ? '%' : m === 'unit' ? '₸/шт' : '₸'; };

  // цикл режима столбца: всего ₸ → за 1 шт → % → ...
  const cycleMode = (c: Col, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasToggle(c)) return;
    const seq: Mode[] = ['total'];
    if (canUnit(c)) seq.push('unit');
    if (canPct(c)) seq.push('pct');
    setColMode((m) => {
      const cur = m[c.key] ?? 'total';
      const next = seq[(seq.indexOf(cur) + 1) % seq.length]!;
      return { ...m, [c.key]: next };
    });
  };

  // единый переключатель всех денежных столбцов: всего → за 1 шт → %
  const cycleAll = () => {
    const order: Mode[] = ['total', 'unit', 'pct'];
    const next = order[(order.indexOf(allMode) + 1) % order.length]!;
    setAllMode(next);
    const m: Record<string, Mode> = {};
    for (const c of FLAT) {
      if (c.kind !== 'money') continue;
      m[c.key] = next === 'unit' && !c.noUnit ? 'unit' : next === 'pct' && !c.noPct ? 'pct' : 'total';
    }
    setColMode(m);
  };
  const allLabel = allMode === 'unit' ? 'Все: за 1 шт' : allMode === 'pct' ? 'Все: %' : 'Все: ₸';

  // цвет по порогам (переопределяет цвет по умолчанию)
  function thresholdClass(c: Col, r: UnitRow): string | undefined {
    const rule = rules[c.key];
    if (rule && (rule.green != null || rule.red != null)) {
      const n = cellNumber(c, r, modeOf(c));
      const g = rule.green, rd = rule.red;
      if (g != null && rd != null) {
        if (g <= rd) return n <= g ? styles.cellGood : n >= rd ? styles.cellBad : styles.cellWarn;
        return n >= g ? styles.cellGood : n <= rd ? styles.cellBad : styles.cellWarn;
      }
      if (g != null) return n <= g ? styles.cellGood : undefined;
      if (rd != null) return n >= rd ? styles.cellBad : undefined;
    }
    if (c.color === 'margin') return styles[marginLevel(c.get(r))];
    if (c.color === 'profit') return c.get(r) < 0 ? styles.bad : styles.good;
    if (c.kind === 'money' || c.kind === 'count') return styles.cost;
    return undefined;
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg('Читаю файл…');
    try {
      const wb = XLSX.read(await file.arrayBuffer());
      const ws = wb.SheetNames[0] ? wb.Sheets[wb.SheetNames[0]] : undefined;
      if (!ws) { setImportMsg('Пустой файл'); return; }
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, raw: true });
      const known = new Set(rows.map((r) => r.sku));
      const ncols = Math.max(...aoa.map((r) => r.length), 0);
      const header = (aoa[0] ?? []).map((x) => String(x ?? '').toLowerCase());
      const body = aoa.slice(1).filter((r) => r.some((x) => String(x ?? '').trim()));

      // 1) есть ли колонка с артикулами (значения совпадают с нашими SKU)?
      let skuCol = header.findIndex((h) => /артикул|sku/.test(h));
      if (skuCol < 0) {
        for (let c = 0; c < ncols; c++) {
          const hits = body.filter((r) => known.has(String(r[c] ?? '').trim())).length;
          if (hits > body.length * 0.3) { skuCol = c; break; }
        }
      }

      let items: { sku: string; cogs?: number; cogsYuan?: number; chinaDelivery?: number }[] = [];
      let fx: number | undefined;
      let info = '';

      if (skuCol >= 0) {
        // ── режим АРТИКУЛ: себест берём из числовой колонки ──
        let valCol = header.findIndex((h) => /себест|закуп|cogs|cost|цена/.test(h));
        if (valCol < 0) {
          for (let c = 0; c < ncols; c++) {
            if (c === skuCol) continue;
            const nums = body.filter((r) => Number.isFinite(Number(r[c]))).length;
            if (nums > body.length * 0.5) { valCol = c; break; }
          }
        }
        if (valCol < 0) { setImportMsg('Нашёл артикулы, но не нашёл колонку с себестоимостью.'); return; }
        items = body
          .map((r) => ({ sku: String(r[skuCol] ?? '').trim(), cogs: Number(r[valCol]) }))
          .filter((x) => x.sku && known.has(x.sku) && Number.isFinite(x.cogs));
        info = `по артикулу (столбец #${skuCol + 1})`;
      } else {
        // ── режим КОДЫ МОДЕЛЕЙ (как Book1): матчим код в название товара ──
        const nameCol = header.findIndex((h) => /наимен|товар|модель|name/.test(h)) >= 0
          ? header.findIndex((h) => /наимен|товар|модель|name/.test(h)) : 0;
        let zCol = header.findIndex((h) => /закуп|юан|cogs|cost|себест|цена/.test(h));
        if (zCol < 0) {
          for (let c = 0; c < ncols; c++) {
            if (c === nameCol) continue;
            const nums = body.filter((r) => Number(r[c]) > 0).length;
            if (nums > body.length * 0.4) { zCol = c; break; }
          }
        }
        const kCol = header.findIndex((h) => /курс|rate|fx/.test(h));
        const dCol = header.findIndex((h) => /достав/.test(h)); // доставка из Китая, ₸/шт
        const codes = body
          .map((r) => ({
            code: String(r[nameCol] ?? '').trim(),
            z: Number(r[zCol]),
            k: kCol >= 0 ? Number(r[kCol]) : 0,
            d: dCol >= 0 ? Number(r[dCol]) : NaN,
          }))
          .filter((c) => c.code && Number.isFinite(c.z) && c.z > 0)
          .map((c) => ({ ...c, regs: c.code.toUpperCase().split(/\s+/).filter(Boolean).map(tokenRegex) }));
        fx = codes.find((c) => c.k > 0)?.k;
        // для каждого нашего товара ищем самый специфичный код
        for (const p of rows) {
          let best: (typeof codes)[number] | null = null, score = 0;
          for (const c of codes) {
            if (c.regs.every((rg) => rg.test(p.name))) {
              const s = c.regs.length * 1000 + c.code.length;
              if (s > score) { best = c; score = s; }
            }
          }
          if (best) items.push({ sku: p.sku, cogsYuan: best.z, ...(Number.isFinite(best.d) ? { chinaDelivery: best.d } : {}) });
        }
        const withChina = items.filter((i) => i.chinaDelivery != null).length;
        info = `по коду модели${fx ? `, курс ${fx}` : ''}${withChina ? `, доставка Китай ${withChina}` : ''}`;
      }

      if (items.length === 0) { setImportMsg('Совпадений не найдено — проверь, что в файле есть артикулы или коды моделей.'); return; }
      const res = await costsApi.importCogs(items, fx);
      setImportMsg(`Загружено: ${res.updated} из ${items.length} (${info})`);
      load();
    } catch {
      setImportMsg('Ошибка чтения файла.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const startEdit = (c: Col, r: UnitRow) => {
    // упаковка редактируется ЗА 1 ШТ (столбец показывает всего); вес/дост-за-кг/курсы — как есть
    const seed = c.edit === 'pack' ? r.packagingPerUnit : c.get(r);
    setEdit({ sku: r.sku, key: c.key });
    setEditVal(String(seed || ''));
  };
  const commitEdit = async (c: Col, r: UnitRow) => {
    const num = Number(editVal.replace(',', '.'));
    setEdit(null);
    if (!Number.isFinite(num) || num < 0) return;
    try {
      if (c.edit === 'yuan') await costsApi.setCogs(r.sku, num);
      else if (c.edit === 'fx') await costsApi.setFx(num);
      else if (c.edit === 'usd') await costsApi.setUsd(num);
      else if (c.edit === 'weight') await costsApi.setWeight(r.sku, num);
      else if (c.edit === 'perkg') await costsApi.setPerKg(r.sku, num);
      else if (c.edit === 'pack') await costsApi.setPackaging(r.sku, num);
      load();
    } catch { /* ignore */ }
  };

  const renderRow = (r: UnitRow) => (
    <tr key={r.sku}>
      <td className={`${styles.left} ${styles.colPhoto}`}>
        <div className={styles.thumb}>
          {r.image
            ? <img className={styles.thumbImg} src={r.image} alt="" loading="lazy"
                onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : r.name.slice(0, 1)}
        </div>
      </td>
      <td className={`${styles.left} ${styles.skuCode} ${styles.colArticle}`}>{r.sku}</td>
      <td className={`${styles.left} ${styles.skuName} ${styles.colName}`}>{r.name}</td>
      {FLAT.map((c) => {
        if (c.edit && edit?.sku === r.sku && edit?.key === c.key) {
          return (
            <td key={c.key}>
              <input className={styles.editInput} autoFocus type="number" value={editVal}
                onChange={(e) => setEditVal(e.target.value)}
                onBlur={() => commitEdit(c, r)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(c, r); if (e.key === 'Escape') setEdit(null); }} />
            </td>
          );
        }
        return (
          <td
            key={c.key}
            className={`${thresholdClass(c, r) ?? ''} ${c.edit ? styles.editable : ''}`}
            onClick={c.edit ? () => startEdit(c, r) : undefined}
            title={c.edit === 'pack' ? 'Клик — изменить (упаковка за 1 шт, ₸)' : c.edit === 'weight' ? 'Клик — изменить (вес за 1 шт, кг)' : c.edit === 'perkg' ? 'Клик — изменить (доставка за 1 кг, $)' : c.edit === 'usd' ? 'Клик — изменить (курс $, общий)' : c.edit === 'fx' ? 'Клик — изменить (курс ¥, общий)' : c.edit ? 'Клик — изменить' : undefined}
          >
            {cellText(c, r, modeOf(c))}
          </td>
        );
      })}
    </tr>
  );

  const numericCols = FLAT; // все числовые столбцы доступны для порогов

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Юнит-экономика (UNIT)</h1>
        <FilterBar
          search={search}
          onSearch={setSearch}
          categories={categories}
          category={category}
          onCategory={setCategory}
          group={group}
          onGroup={() => setGroup((g) => !g)}
        >
          <button type="button" className={filterChip(allMode !== 'total')} onClick={cycleAll} title="Переключить все денежные столбцы">
            {allLabel}
          </button>
          <button type="button" className={filterChip(showThresholds)} onClick={() => setShowThresholds((s) => !s)}>
            Пороги-цвета
          </button>
          <button type="button" className={filterChip(showFilters || activeFilters > 0)} onClick={() => setShowFilters((s) => !s)}>
            Фильтры{activeFilters > 0 ? ` (${activeFilters})` : ''}
          </button>
          <label className={styles.importBtn}>
            Импорт Excel
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onFile} />
          </label>
        </FilterBar>
      </header>

      {importMsg && <div className={styles.importMsg}>{importMsg}</div>}

      {showThresholds && (
        <div className={styles.thrPanel}>
          <div className={styles.thrHint}>
            Задай порог в единицах столбца (для %-столбцов — проценты, для денег — в текущем режиме ₸/%).
            Зелёный ≤ red ⇒ «меньше — лучше»; зелёный &gt; red ⇒ «больше — лучше».
          </div>
          <div className={styles.thrGrid}>
            {numericCols.map((c) => {
              const rule = rules[c.key] ?? { green: null, red: null };
              const upd = (k: 'green' | 'red', v: string) => {
                const num = v === '' ? null : Number(v);
                saveRules({ ...rules, [c.key]: { ...rule, [k]: num } });
              };
              return (
                <div key={c.key} className={styles.thrRow}>
                  <span className={styles.thrLabel}>{c.label}</span>
                  <input className={styles.thrInput} type="number" placeholder="зелёный"
                    value={rule.green ?? ''} onChange={(e) => upd('green', e.target.value)} />
                  <input className={styles.thrInput} type="number" placeholder="красный"
                    value={rule.red ?? ''} onChange={(e) => upd('red', e.target.value)} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showFilters && (
        <div className={styles.thrPanel}>
          <div className={styles.thrHint}>
            Показываем только товары, проходящие <b>все</b> условия. Деньги — в ₸ (всего за период), доли (маржа, ДРР, % возврата, рассрочка, CTR, ROI) — в процентах.
          </div>
          {filters.map((f) => (
            <div key={f.id} className={styles.filterRow}>
              <select className={styles.filterField} value={f.key} onChange={(e) => updFilter(f.id, { key: e.target.value })}>
                {FLAT.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <select className={styles.filterOp} value={f.op} onChange={(e) => updFilter(f.id, { op: e.target.value as '>=' | '<=' })}>
                <option value=">=">≥</option>
                <option value="<=">≤</option>
              </select>
              <input className={styles.thrInput} type="number" placeholder="значение" value={f.value}
                onChange={(e) => updFilter(f.id, { value: e.target.value })} />
              <button type="button" className={styles.filterDel} onClick={() => delFilter(f.id)} title="Удалить условие">✕</button>
            </div>
          ))}
          <div className={styles.filterActions}>
            <button type="button" className={styles.filterAdd} onClick={addFilter}>+ Добавить условие</button>
            {filters.length > 0 && (
              <button type="button" className={styles.filterReset} onClick={() => saveFilters([])}>Сбросить все</button>
            )}
            <span className={styles.filterCount}>Показано {filtered.length} из {rows.length}</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className={styles.placeholder}>Загрузка…</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th colSpan={3} className={`${styles.blockHead} ${styles.stickyBlock}`}>Товар</th>
                {BLOCKS.map((b) => <th key={b.name} colSpan={b.cols.length} className={styles.blockHead}>{b.name}</th>)}
              </tr>
              <tr>
                <th className={styles.colPhoto}>Фото</th>
                <th className={`${styles.left} ${styles.thSort} ${styles.colArticle}`} onClick={() => clickSort('article')}>Артикул{arrow('article')}</th>
                <th className={`${styles.left} ${styles.thSort} ${styles.colName}`} onClick={() => clickSort('name')}>Название{arrow('name')}</th>
                {FLAT.map((c) => (
                  <th key={c.key} className={styles.thSort} onClick={() => clickSort(c.key)}>
                    {c.label}{arrow(c.key)}
                    {hasToggle(c) && (
                      <span className={styles.modeBadge} onClick={(e) => cycleMode(c, e)} title="₸ всего → ₸ за 1 шт → %">
                        {badge(c)}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!group && filtered.map(renderRow)}
              {group && groups!.map((g) => {
                const isCol = collapsed.has(g.cat);
                return (
                  <Fragment key={g.cat}>
                    <tr className={styles.groupHead} onClick={() => toggleGroup(g.cat)}>
                      <td className={`${styles.left} ${styles.stickyBlock}`} colSpan={3}>
                        <span className={styles.groupTri}>{isCol ? '▶' : '▼'}</span> {catRu(g.cat)} <span className={styles.groupCount}>· {g.items.length} тов.</span>
                      </td>
                      <td colSpan={TOTAL_COLS - 3} className={styles.groupSub}>Выручка {tenge(g.revenue)} · Прибыль {tenge(g.profit)}</td>
                    </tr>
                    {!isCol && g.items.map(renderRow)}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && <tr><td className={styles.empty} colSpan={TOTAL_COLS}>Ничего не найдено</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
