import { Fragment, useEffect, useMemo, useState } from 'react';
import { rnpApi } from '../../api/rnp';
import { tenge, percent, qty } from '../../utils/format';
import { catRu } from '../../utils/category';
import { FilterBar, filterChip } from '../../components/FilterBar/FilterBar';
import type { PlanRow } from '../../types/rnp';
import { recentMonths } from '../../utils/months';
import styles from './PlanPage.module.css';

const MONTHS = recentMonths();
const COLSPAN = 14;

/** % выполнения плана → класс цвета. */
function doneClass(done: number): string {
  if (done >= 1) return styles.good!;
  if (done >= 0.85) return styles.warn!;
  return styles.bad!;
}

// редактируемые поля (ДРР и маржа — в процентах)
type EditKey = 'planSum' | 'planQty' | 'targetDrr' | 'planProfit' | 'planMargin';

export function PlanPage() {
  const [month, setMonth] = useState(MONTHS[0]!);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [onlyPlanned, setOnlyPlanned] = useState(false);
  const [group, setGroup] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ sku: string; key: EditKey } | null>(null);
  const [editVal, setEditVal] = useState('');

  const toggleGroup = (cat: string) => setCollapsed((s) => {
    const n = new Set(s); if (n.has(cat)) n.delete(cat); else n.add(cat); return n;
  });

  const load = () => {
    setLoading(true);
    rnpApi
      .plan(month)
      .then((res) => setRows(res.items))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [month]);

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category))].filter(Boolean).sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (category && r.category !== category) return false;
      if (onlyPlanned && r.planSum <= 0 && r.planQty <= 0) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.sku.includes(q)) return false;
      return true;
    });
  }, [rows, search, category, onlyPlanned]);

  const groups = useMemo(() => {
    if (!group) return null;
    const map = new Map<string, PlanRow[]>();
    for (const r of filtered) { const a = map.get(r.category) ?? []; a.push(r); map.set(r.category, a); }
    return [...map.entries()]
      .map(([cat, items]) => ({
        cat, items,
        planSum: items.reduce((s, x) => s + x.planSum, 0),
        factSum: items.reduce((s, x) => s + x.factSum, 0),
      }))
      .sort((a, b) => b.factSum - a.factSum);
  }, [filtered, group]);

  const totals = useMemo(() => filtered.reduce(
    (a, r) => ({
      planSum: a.planSum + r.planSum, factSum: a.factSum + r.factSum,
      planQty: a.planQty + r.planQty, factQty: a.factQty + r.factQty,
      planProfit: a.planProfit + r.planProfit, profit: a.profit + r.profit,
    }),
    { planSum: 0, factSum: 0, planQty: 0, factQty: 0, planProfit: 0, profit: 0 },
  ), [filtered]);

  // сохранить патч строки (локально оптимистично + на сервер)
  const save = async (r: PlanRow, patch: Partial<PlanRow>) => {
    const merged = { ...r, ...patch };
    setRows((prev) => prev.map((x) => (x.sku === r.sku ? merged : x)));
    try {
      await rnpApi.savePlan({
        sku: r.sku, month,
        planSum: merged.planSum, planQty: merged.planQty,
        targetDrr: merged.targetDrr, planProfit: merged.planProfit, approved: merged.approved,
      });
    } catch {
      load();
    }
  };

  const startEdit = (r: PlanRow, key: EditKey) => {
    const seed = key === 'targetDrr' ? r.targetDrr * 100 : key === 'planMargin' ? r.planMargin * 100 : r[key];
    setEdit({ sku: r.sku, key });
    setEditVal(seed ? String(Math.round(Number(seed) * 100) / 100) : '');
  };

  const commitEdit = async (r: PlanRow) => {
    if (!edit) return;
    const key = edit.key;
    setEdit(null);
    const num = Number(editVal.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) return;
    if (key === 'targetDrr') await save(r, { targetDrr: num / 100 });
    else if (key === 'planMargin') {
      const profit = Math.round(r.planSum * (num / 100));
      await save(r, { planMargin: num / 100, planProfit: profit });
    } else if (key === 'planProfit') {
      await save(r, { planProfit: Math.round(num), planMargin: r.planSum > 0 ? num / r.planSum : 0 });
    } else if (key === 'planSum') {
      await save(r, { planSum: Math.round(num), planMargin: num > 0 ? r.planProfit / num : 0 });
    } else {
      await save(r, { planQty: Math.round(num) });
    }
  };

  const editCell = (r: PlanRow, key: EditKey, display: string) => {
    if (edit?.sku === r.sku && edit?.key === key) {
      return (
        <td>
          <input
            className={styles.editInput}
            autoFocus
            type="number"
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            onBlur={() => commitEdit(r)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit(r);
              if (e.key === 'Escape') setEdit(null);
            }}
          />
        </td>
      );
    }
    return (
      <td className={styles.editable} onClick={() => startEdit(r, key)} title="Клик — изменить">
        {display}
      </td>
    );
  };

  const renderRow = (r: PlanRow) => {
    const doneSum = r.planSum ? r.factSum / r.planSum : 0;
    return (
      <tr key={r.sku}>
        <td className={`${styles.left} ${styles.colPhoto}`}>
          <div className={styles.thumb}>
            {r.image
              ? <img className={styles.thumbImg} src={r.image} alt="" loading="lazy"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              : (r.name || r.sku).slice(0, 1)}
          </div>
        </td>
        <td className={`${styles.left} ${styles.colArticle}`}>
          <div className={styles.skuArticle}>{r.sku}</div>
          <div className={styles.skuCode}>{catRu(r.category)}</div>
        </td>
        <td className={`${styles.left} ${styles.colName}`}>
          <div className={styles.skuName}>{r.name || r.sku}</div>
        </td>
        {editCell(r, 'planSum', r.planSum ? tenge(r.planSum) : '—')}
        <td>{tenge(r.factSum)}</td>
        <td className={r.planSum ? doneClass(doneSum) : styles.muted}>{r.planSum ? percent(doneSum, 0) : '—'}</td>
        {editCell(r, 'planQty', r.planQty ? qty(r.planQty) : '—')}
        <td>{qty(r.factQty)}</td>
        {editCell(r, 'targetDrr', r.targetDrr ? percent(r.targetDrr) : '—')}
        {editCell(r, 'planProfit', r.planProfit ? tenge(r.planProfit) : '—')}
        {editCell(r, 'planMargin', r.planMargin ? percent(r.planMargin) : '—')}
        <td>{percent(r.marginWAds)}</td>
        <td className={r.profit < 0 ? styles.bad : styles.good}>{tenge(r.profit)}</td>
        <td>
          <button
            type="button"
            className={`${styles.badge} ${styles.badgeBtn} ${r.approved ? styles.badgeOk : styles.badgeWait}`}
            onClick={() => save(r, { approved: !r.approved })}
            title="Клик — переключить согласование"
          >
            {r.approved ? 'согласован' : 'черновик'}
          </button>
        </td>
      </tr>
    );
  };

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>План / Факт (ПЛАН)</h1>
        <select className={styles.select} value={month} onChange={(e) => setMonth(e.target.value)}>
          {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </header>

      <FilterBar
        search={search}
        onSearch={setSearch}
        categories={categories}
        category={category}
        onCategory={setCategory}
        group={group}
        onGroup={() => setGroup((g) => !g)}
      >
        <button type="button" className={filterChip(onlyPlanned)} onClick={() => setOnlyPlanned((v) => !v)}>
          {onlyPlanned ? '✓ только с планом' : 'только с планом'}
        </button>
      </FilterBar>

      <div className={styles.hint}>
        Кликни по ячейке <b>План ₸</b>, <b>План шт</b>, <b>Цель ДРР</b>, <b>План прибыль</b> или <b>План маржа</b>, чтобы задать значение —
        план сразу попадёт в РНП-дашборд. Маржа и прибыль связаны: задаёшь одно — второе пересчитывается от плана выручки.
      </div>

      {loading ? (
        <div className={styles.placeholder}>Загрузка…</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={`${styles.left} ${styles.colPhoto}`}>Фото</th>
                <th className={`${styles.left} ${styles.colArticle}`}>Артикул</th>
                <th className={`${styles.left} ${styles.colName}`}>Товар</th>
                <th>План ₸</th>
                <th>Факт ₸</th>
                <th>Вып. ₸</th>
                <th>План шт</th>
                <th>Факт шт</th>
                <th>Цель ДРР</th>
                <th>План прибыль</th>
                <th>План маржа</th>
                <th>Факт маржа</th>
                <th>Факт прибыль</th>
                <th>Статус</th>
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
                      <td className={styles.groupSub}>{g.planSum ? tenge(g.planSum) : '—'}</td>
                      <td className={styles.groupSub}>{tenge(g.factSum)}</td>
                      <td className={styles.groupSub} colSpan={COLSPAN - 5} />
                    </tr>
                    {!isCol && g.items.map(renderRow)}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td className={styles.muted} colSpan={COLSPAN} style={{ textAlign: 'center', padding: 32 }}>Ничего не найдено</td></tr>
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr className={styles.totalRow}>
                  <td className={`${styles.left} ${styles.stickyBlock}`} colSpan={3}>Итого: {filtered.length} тов.</td>
                  <td>{tenge(totals.planSum)}</td>
                  <td>{tenge(totals.factSum)}</td>
                  <td className={totals.planSum ? doneClass(totals.factSum / totals.planSum) : styles.muted}>
                    {totals.planSum ? percent(totals.factSum / totals.planSum, 0) : '—'}
                  </td>
                  <td>{qty(totals.planQty)}</td>
                  <td>{qty(totals.factQty)}</td>
                  <td className={styles.muted}>—</td>
                  <td>{totals.planProfit ? tenge(totals.planProfit) : '—'}</td>
                  <td className={totals.planSum ? '' : styles.muted}>{totals.planSum ? percent(totals.planProfit / totals.planSum) : '—'}</td>
                  <td className={styles.muted}>—</td>
                  <td className={totals.profit < 0 ? styles.bad : styles.good}>{tenge(totals.profit)}</td>
                  <td className={styles.muted}>—</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  );
}
