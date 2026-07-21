import type { ReactNode } from 'react';
import { tenge, percent } from '../../utils/format';
import { catRu } from '../../utils/category';
import type { MetricSet, ProductRowData, MetricFormat } from '../../types/dashboard';
import styles from './ProductTable.module.css';

const nf = new Intl.NumberFormat('ru-RU');

function fmt(v: number, f: MetricFormat): string {
  if (f === 'pct') return percent(v);
  return nf.format(Math.round(v));
}

interface MetricDef {
  label: string;
  field: keyof MetricSet;
  format: MetricFormat;
}
interface Group {
  key: string;
  primary: MetricDef;
  secondary: MetricDef;
  higherIsBetter: boolean;
}

const GROUPS: Group[] = [
  {
    key: 'orders', higherIsBetter: true,
    primary: { label: 'Заказы ₸', field: 'ordersSum', format: 'money' },
    secondary: { label: 'Заказы шт', field: 'ordersQty', format: 'qty' },
  },
  {
    key: 'buyout', higherIsBetter: true,
    primary: { label: 'Выкупы ₸', field: 'buyoutSum', format: 'money' },
    secondary: { label: 'Выкупы шт', field: 'buyoutQty', format: 'qty' },
  },
  {
    key: 'ad', higherIsBetter: false,
    primary: { label: 'Реклама ₸', field: 'adSum', format: 'money' },
    secondary: { label: 'ДРР %', field: 'drr', format: 'pct' },
  },
  {
    key: 'profit', higherIsBetter: true,
    primary: { label: 'Прибыль ₸', field: 'profit', format: 'money' },
    secondary: { label: 'Маржа %', field: 'margin', format: 'pct' },
  },
];

function Delta({ value, base }: { value: number; base: number }) {
  if (!base) return null;
  const pct = value / base;
  const up = pct >= 1;
  return (
    <span className={up ? styles.up : styles.down}>
      {up ? '↑' : '↓'}{Math.round(pct * 100)}%
    </span>
  );
}

/** Колонка периода: на каждую группу — подпись+дельта, крупное значение, мелкая строка (шт/%). */
function PeriodCol({ set, compare }: { set: MetricSet; compare?: MetricSet }) {
  return (
    <div className={styles.colPeriod}>
      {GROUPS.map((g) => (
        <div className={styles.group} key={g.key}>
          <div className={styles.mLine}>
            <span className={styles.mLabel}>{g.primary.label}</span>
            <span className={styles.mRight}>
              {compare && <Delta value={set[g.primary.field]} base={compare[g.primary.field]} />}
              <b className={styles.mVal}>{fmt(set[g.primary.field], g.primary.format)}</b>
            </span>
          </div>
          <div className={styles.mLine}>
            <span className={styles.mLabelSub}>{g.secondary.label}</span>
            <span className={styles.mValSub}>{fmt(set[g.secondary.field], g.secondary.format)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Колонка одного дня: 4 группы, крупное значение + мелкое, подсветка vs план дня. */
function DayCol({ day, planDay }: { day: MetricSet; planDay: MetricSet }) {
  return (
    <div className={styles.colDay}>
      {GROUPS.map((g) => {
        const v = day[g.primary.field];
        const p = planDay[g.primary.field];
        const good = g.higherIsBetter ? v >= p : v <= p;
        return (
          <div
            className={`${styles.group} ${styles.dayGroup} ${good ? styles.good : styles.bad}`}
            key={g.key}
          >
            <div className={styles.dayPrimary}>{fmt(v, g.primary.format)}</div>
            <div className={styles.daySecondary}>{fmt(day[g.secondary.field], g.secondary.format)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const w = 120, h = 44;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="var(--good)" strokeWidth="1.5" />
    </svg>
  );
}

export interface Cols {
  planDay: boolean;
  planMonth: boolean;
  forecast: boolean;
  fact: boolean;
  graph: boolean;
}

const PERIODS: {
  key: keyof Cols;
  title: string;
  get: (p: ProductRowData) => MetricSet;
  compare?: (p: ProductRowData) => MetricSet;
}[] = [
  { key: 'planDay', title: 'ПЛАН ДЕНЬ', get: (p) => p.planDay },
  { key: 'planMonth', title: 'ПЛАН МЕС.', get: (p) => p.planMonth },
  { key: 'forecast', title: 'ПРОГНОЗ МЕС.', get: (p) => p.forecastMonth, compare: (p) => p.planMonth },
  { key: 'fact', title: 'ФАКТ МЕС.', get: (p) => p.factMonth, compare: (p) => p.planMonth },
];

function ProductBand({ p, cols }: { p: ProductRowData; cols: Cols }) {
  return (
    <div className={styles.band}>
      <div className={`${styles.colProduct} ${styles.sticky}`}>
        <div className={styles.thumb}>
          {p.image
            ? <img className={styles.thumbImg} src={p.image} alt="" loading="lazy"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : p.name.slice(0, 1)}
        </div>
        <div className={styles.pMeta}>
          <div className={styles.pSku}>{p.sku}</div>
          <div className={styles.pArticle}>{catRu(p.article)}</div>
          <div className={styles.pName}>{p.name}</div>
          <div className={styles.pPrice}>{tenge(p.price)}</div>
          <div className={styles.pSeller}>{p.seller}</div>
        </div>
      </div>

      <div className={styles.colInfo}>
        {/* «Сумма заказов» — валовая, как в кабинете Kaspi (вкл. отменённые).
            Деньги, которые реально дошли, — это «Выкуп» ниже: отменённый заказ продажей не является. */}
        <div className={styles.infoLine}><span>Заказы</span><b>{nf.format(p.ordersQty)} шт</b></div>
        <div className={styles.infoLine}><span>Сумма заказов</span><b>{tenge(p.revenue)}</b></div>
        <div className={styles.infoLine}><span>Выкуп</span><b>{tenge(p.factMonth.buyoutSum)}</b></div>
        <div className={styles.badgeGood}>Маржа до ДРР {percent(p.marginNoAds)}</div>
        <div className={styles.badgeWarn}>Маржа с ДРР {percent(p.marginWAds)}</div>
      </div>

      <div className={styles.colInfo}>
        <div className={styles.infoLine}><span>Остаток</span><b>{nf.format(p.stock.stock)}</b></div>
        {/* daysLeft = null — продаж нет, делить не на что: «—», а не «0 дн» */}
        <div className={styles.infoLine}><span>Хватит</span><b>{p.stock.daysLeft == null ? '—' : `${p.stock.daysLeft} дн`}</b></div>
        <div className={styles.infoLine}><span>Отмены</span><b>{percent(p.stock.cancelPct)}</b></div>
        <div className={styles.infoLine}><span>Возвраты</span><b>{percent(p.stock.returnPct)}</b></div>
        <div className={styles.infoLine}><span>Выкуп</span><b>{percent(p.stock.buyoutPct)}</b></div>
        <div className={styles.infoLine}><span>ДРР цель</span><b>{percent(p.stock.drr)}</b></div>
      </div>

      {PERIODS.filter((pc) => cols[pc.key]).map((pc) => (
        <PeriodCol key={pc.key} set={pc.get(p)} compare={pc.compare?.(p)} />
      ))}

      {cols.graph && (
        <div className={styles.colGraph}>
          <Sparkline data={p.spark} />
        </div>
      )}

      {p.daily.map((d, i) => (
        <DayCol key={i} day={d} planDay={p.planDay} />
      ))}
    </div>
  );
}

export function ProductTable({ products, days, cols, group, collapsed, onToggleGroup }: {
  products: ProductRowData[]; days: string[]; cols: Cols; group?: boolean;
  collapsed?: Set<string>; onToggleGroup?: (cat: string) => void;
}) {
  const body = (): ReactNode => {
    if (!group) return products.map((p) => <ProductBand key={p.sku} p={p} cols={cols} />);
    // products уже отсортированы по article (категории) — идём подряд группами
    const out: ReactNode[] = [];
    for (let i = 0; i < products.length; ) {
      const cat = products[i]!.article;
      const items: ProductRowData[] = [];
      while (i < products.length && products[i]!.article === cat) { items.push(products[i]!); i++; }
      const isCollapsed = collapsed?.has(cat) ?? false;
      out.push(
        <div key={`g-${cat}`} className={styles.groupBand} onClick={() => onToggleGroup?.(cat)}>
          <span className={styles.groupTri}>{isCollapsed ? '▶' : '▼'}</span>
          {catRu(cat)}
          <span className={styles.groupCnt}>· {items.length} тов.</span>
        </div>,
      );
      if (!isCollapsed) for (const p of items) out.push(<ProductBand key={p.sku} p={p} cols={cols} />);
    }
    return out;
  };

  return (
    <div className={styles.scroller}>
      <div className={styles.head}>
        <div className={`${styles.hCell} ${styles.colProduct} ${styles.sticky}`}>ТОВАР</div>
        <div className={`${styles.hCell} ${styles.colInfo}`}>ПОКАЗАТЕЛИ</div>
        <div className={`${styles.hCell} ${styles.colInfo}`}>ОСТАТКИ / КОНВ.</div>
        {PERIODS.filter((pc) => cols[pc.key]).map((pc) => (
          <div className={`${styles.hCell} ${styles.colPeriod}`} key={pc.key}>{pc.title}</div>
        ))}
        {cols.graph && <div className={`${styles.hCell} ${styles.colGraph}`}>ГРАФИКИ 30Д</div>}
        {days.map((d) => (
          <div className={`${styles.hCell} ${styles.colDay}`} key={d}>{d}</div>
        ))}
      </div>
      {body()}
    </div>
  );
}
