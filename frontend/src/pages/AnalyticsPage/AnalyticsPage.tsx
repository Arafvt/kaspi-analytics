import { useEffect, useState } from 'react';
import { rnpApi } from '../../api/rnp';
import { tenge, percent, qty } from '../../utils/format';
import { catRu } from '../../utils/category';
import type { AnalyticsData } from '../../types/rnp';
import { recentMonths } from '../../utils/months';
import styles from './AnalyticsPage.module.css';

const MONTHS = recentMonths();
const abcClass: Record<string, string> = { A: styles.bA!, B: styles.bB!, C: styles.bC!, D: styles.bD! };
const abcCardClass: Record<string, string> = { A: styles.abcA!, B: styles.abcB!, C: styles.abcC!, D: styles.abcD! };
const groupHint: Record<string, string> = {
  A: 'дают 80% прибыли', B: 'следующие 15%', C: 'последние 5%', D: 'убыточные',
};

export function AnalyticsPage() {
  const [month, setMonth] = useState(MONTHS[0]!);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    rnpApi.analytics(month).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [month]);

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Аналитика</h1>
        <select className={styles.select} value={month} onChange={(e) => setMonth(e.target.value)}>
          {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </header>

      {loading || !data ? (
        <div className={styles.placeholder}>{loading ? 'Загрузка…' : 'Нет данных'}</div>
      ) : (
        <>
          {/* Сводка */}
          <div className={styles.cards}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Прибыль за месяц</div>
              <div className={`${styles.cardValue} ${data.summary.totalProfit < 0 ? styles.bad : styles.good}`}>{tenge(data.summary.totalProfit)}</div>
              <div className={styles.cardSub}>{data.summary.skuCount} товаров</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Группа A (ядро)</div>
              <div className={styles.cardValue}>{data.summary.aCount}</div>
              <div className={styles.cardSub}>товаров дают 80% прибыли</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Убыточные товары</div>
              <div className={`${styles.cardValue} ${data.summary.lossMakingCount > 0 ? styles.bad : ''}`}>{data.summary.lossMakingCount}</div>
              <div className={styles.cardSub}>минус даже без рекламы</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Резерв на возвраты</div>
              <div className={styles.cardValue}>{tenge(data.summary.returnReserve)}</div>
              <div className={styles.cardSub}>потерянная доставка</div>
            </div>
          </div>

          {/* ABC-анализ */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              ABC-анализ
              <span className={styles.sectionHint}>вклад товаров в прибыль — куда смотреть в первую очередь</span>
            </div>
            <div className={styles.abcRow}>
              {data.abcGroups.map((g) => (
                <div key={g.group} className={`${styles.abcCard} ${abcCardClass[g.group]}`}>
                  <div className={styles.abcGroupName}>Группа {g.group} · {g.count} тов.</div>
                  <div className={styles.abcGroupMeta}>{tenge(g.profit)} · {percent(g.share)} прибыли</div>
                  <div className={styles.abcGroupMeta}>{groupHint[g.group]}</div>
                </div>
              ))}
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.left}>Товар</th>
                    <th>Категория</th>
                    <th>Выручка</th>
                    <th>Продано</th>
                    <th>Прибыль</th>
                    <th>Накопл. %</th>
                    <th>Группа</th>
                  </tr>
                </thead>
                <tbody>
                  {data.abc.map((r) => (
                    <tr key={r.sku}>
                      <td className={styles.left}>
                        <div className={styles.skuName}>{r.name || r.sku}</div>
                        <div className={styles.skuCode}>{r.sku}</div>
                      </td>
                      <td className={styles.muted}>{catRu(r.category)}</td>
                      <td>{tenge(r.revenue)}</td>
                      <td>{qty(r.units)}</td>
                      <td className={r.profit < 0 ? styles.bad : styles.good}>{tenge(r.profit)}</td>
                      <td className={styles.muted}>{percent(r.cumShare, 0)}</td>
                      <td><span className={`${styles.badge} ${abcClass[r.group]}`}>{r.group}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Точка безубыточности */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              Точка безубыточности по рекламе
              <span className={styles.sectionHint}>сколько штук нужно продать, чтобы окупить рекламу (убыточные — сверху)</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.left}>Товар</th>
                    <th>Прибыль/шт до рекламы</th>
                    <th>Реклама</th>
                    <th>Окупаемость, шт</th>
                    <th>Продано</th>
                    <th>Запас</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakeven.map((r) => (
                    <tr key={r.sku} className={r.lossMaking ? styles.rowLoss : ''}>
                      <td className={styles.left}>
                        <div className={styles.skuName}>{r.name || r.sku}</div>
                        <div className={styles.skuCode}>{r.sku}</div>
                      </td>
                      <td className={r.unitProfitNoAds < 0 ? styles.bad : styles.good}>{tenge(r.unitProfitNoAds)}</td>
                      <td className={styles.muted}>{r.adSpend > 0 ? tenge(r.adSpend) : '—'}</td>
                      <td>{r.lossMaking ? <span className={styles.bad}>убыточен</span> : r.breakevenUnits > 0 ? qty(r.breakevenUnits) : '—'}</td>
                      <td>{qty(r.actualUnits)}</td>
                      <td className={r.adSpend > 0 ? (r.safetyUnits >= 0 ? styles.good : styles.bad) : styles.muted}>
                        {r.adSpend > 0 && !r.lossMaking ? qty(r.safetyUnits) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Резерв на возвраты */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              Резерв на возвраты
              <span className={styles.sectionHint}>при возврате доставка «туда» не возвращается — закладывай в цену</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.left}>Товар</th>
                    <th>% возврата</th>
                    <th>Возвратов, шт</th>
                    <th>Резерв (потеря)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.returns.map((r) => (
                    <tr key={r.sku}>
                      <td className={styles.left}>
                        <div className={styles.skuName}>{r.name || r.sku}</div>
                        <div className={styles.skuCode}>{r.sku}</div>
                      </td>
                      <td className={r.returnPct > 0.1 ? styles.bad : ''}>{percent(r.returnPct)}</td>
                      <td>{qty(r.returnsQty)}</td>
                      <td className={styles.bad}>{tenge(r.lossReserve)}</td>
                    </tr>
                  ))}
                  {data.returns.length === 0 && (
                    <tr><td className={styles.muted} colSpan={4} style={{ textAlign: 'center', padding: 28 }}>Возвратов за период нет</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
