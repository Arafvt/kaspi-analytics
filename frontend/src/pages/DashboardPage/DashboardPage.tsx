import { useEffect, useMemo, useState } from 'react';
import { rnpApi } from '../../api/rnp';
import { tenge, percent } from '../../utils/format';
import { ProductTable } from '../../components/ProductTable/ProductTable';
import { FilterBar } from '../../components/FilterBar/FilterBar';
import type { DashboardData, MonthBlock, DailyMetric } from '../../types/dashboard';
import styles from './DashboardPage.module.css';

const MONTHS = ['2026-06', '2026-05', '2026-04'];
const nf = new Intl.NumberFormat('ru-RU');

/** Форматирование ячейки динамики по типу метрики. */
function fmtCell(v: number, f: DailyMetric['format']): string {
  if (f === 'pct') return percent(v);
  return nf.format(Math.round(v));
}

/** Дельта факт/прогноз к плану: "↑109%". */
function Delta({ value, plan }: { value: number; plan: number }) {
  if (!plan) return null;
  const pct = value / plan;
  const up = pct >= 1;
  return (
    <span className={up ? styles.deltaUp : styles.deltaDown}>
      {up ? '↑' : '↓'}{Math.round(pct * 100)}%
    </span>
  );
}

function SummaryCard({ title, tone, block, plan }: {
  title: string;
  tone: 'plan' | 'forecast' | 'fact';
  block: MonthBlock;
  plan?: MonthBlock;
}) {
  const row = (label: string, value: string, delta?: React.ReactNode) => (
    <div className={styles.cardRow}>
      <span className={styles.cardLabel}>{label}</span>
      <span className={styles.cardValue}>{delta}{value}</span>
    </div>
  );
  return (
    <div className={`${styles.card} ${styles[`card_${tone}`]}`}>
      <div className={styles.cardTitle}>{title}</div>
      {row('Заказы ₸', tenge(block.ordersSum), plan && <Delta value={block.ordersSum} plan={plan.ordersSum} />)}
      {row('Заказы шт', nf.format(block.ordersQty), plan && <Delta value={block.ordersQty} plan={plan.ordersQty} />)}
      {row('Выкупы ₸', tenge(block.buyoutSum), plan && <Delta value={block.buyoutSum} plan={plan.buyoutSum} />)}
      {row('Выкупы шт', nf.format(block.buyoutQty), plan && <Delta value={block.buyoutQty} plan={plan.buyoutQty} />)}
      {row('Реклама ₸', tenge(block.adSum))}
      {row('ДРР', percent(block.drr, 2))}
      {row('Прибыль ₸', tenge(block.profit), plan && <Delta value={block.profit} plan={plan.profit} />)}
      {row('Маржа', percent(block.margin))}
    </div>
  );
}

function DailyTable({ data, showPlanDay }: { data: DashboardData; showPlanDay: boolean }) {
  const cellTone = (m: DailyMetric, v: number): string => {
    const good = m.higherIsBetter ? v >= m.planDay : v <= m.planDay;
    return good ? styles.cellGood! : styles.cellBad!;
  };
  return (
    <div className={styles.dailyWrap}>
      <table className={styles.daily}>
        <thead>
          <tr>
            <th className={styles.stickyL}>Метрика</th>
            {showPlanDay && <th className={styles.stickyPlan}>План дня</th>}
            {data.days.map((d) => <th key={d}>{d}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.daily.map((m) => (
            <tr key={m.key}>
              <td className={styles.stickyL}>{m.label}</td>
              {showPlanDay && <td className={styles.stickyPlan}>{fmtCell(m.planDay, m.format)}</td>}
              {m.values.map((v, i) => (
                <td key={i} className={cellTone(m, v)}>{fmtCell(v, m.format)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Какие колонки показывать (план дня/мес скрыты по умолчанию — данных нет). */
export interface ColVisibility {
  planDay: boolean;
  planMonth: boolean;
  forecast: boolean;
  fact: boolean;
  graph: boolean;
}

const COL_LABELS: { key: keyof ColVisibility; label: string }[] = [
  { key: 'planDay', label: 'План день' },
  { key: 'planMonth', label: 'План мес.' },
  { key: 'forecast', label: 'Прогноз мес.' },
  { key: 'fact', label: 'Факт мес.' },
  { key: 'graph', label: 'График 30Д' },
];

export function DashboardPage() {
  const [month, setMonth] = useState(MONTHS[0]!);
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cols, setCols] = useState<ColVisibility>({
    planDay: false, planMonth: true, forecast: true, fact: true, graph: true,
  });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [group, setGroup] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (cat: string) => setCollapsed((s) => {
    const n = new Set(s); if (n.has(cat)) n.delete(cat); else n.add(cat); return n;
  });

  useEffect(() => {
    setStatus('loading');
    rnpApi
      .dashboard(month)
      .then((d) => {
        setData(d);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, [month]);

  const allProducts = data?.products ?? [];
  const categories = useMemo(
    () => [...new Set(allProducts.map((p) => p.article))].filter(Boolean).sort(),
    [allProducts],
  );
  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = allProducts.filter((p) => {
      if (category && p.article !== category) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.sku.includes(q)) return false;
      return true;
    });
    if (group) list = [...list].sort((a, b) => a.article.localeCompare(b.article));
    return list;
  }, [allProducts, search, category, group]);

  if (status === 'loading') return <div className={styles.loading}>Загрузка…</div>;
  if (status === 'error' || !data) {
    return <div className={styles.loading}>Нет данных. Подключите Kaspi API и запустите синк.</div>;
  }

  const toggle = (k: keyof ColVisibility) => setCols((c) => ({ ...c, [k]: !c[k] }));

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Дашборд</h1>
        <div className={styles.toolbar}>
          <select className={styles.select} value={month} onChange={(e) => setMonth(e.target.value)}>
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </header>

      {/* Фильтр столбцов */}
      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>Столбцы:</span>
        {COL_LABELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`${styles.chip} ${cols[key] ? styles.chipOn : ''}`}
            onClick={() => toggle(key)}
          >
            {cols[key] ? '✓ ' : ''}{label}
          </button>
        ))}
      </div>

      <div className={styles.cards}>
        {cols.planMonth && <SummaryCard title="ПЛАН МЕСЯЦА" tone="plan" block={data.summary.plan} />}
        {cols.forecast && <SummaryCard title="ПРОГНОЗ МЕСЯЦА" tone="forecast" block={data.summary.forecast} plan={data.summary.plan} />}
        {cols.fact && <SummaryCard title="ФАКТ МЕСЯЦА" tone="fact" block={data.summary.fact} plan={data.summary.plan} />}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Динамика по дням
          <span className={styles.sectionHint}>цвет ячеек — сравнение со средним по дням</span>
        </div>
        <DailyTable data={data} showPlanDay={cols.planDay} />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Товары
          <span className={styles.sectionHint}>{products.length} из {allProducts.length}</span>
        </div>
        <FilterBar
          search={search}
          onSearch={setSearch}
          categories={categories}
          category={category}
          onCategory={setCategory}
          group={group}
          onGroup={() => setGroup((g) => !g)}
        />
        <ProductTable products={products} days={data.days} cols={cols} group={group} collapsed={collapsed} onToggleGroup={toggleGroup} />
      </div>
    </section>
  );
}
