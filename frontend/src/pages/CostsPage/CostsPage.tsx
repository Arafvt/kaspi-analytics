import { useEffect, useState } from 'react';
import { tenge, percent } from '../../utils/format';
import { catRu } from '../../utils/category';
import { costsApi, type CogsRow, type CommissionRow } from '../../api/rnp';
import styles from './CostsPage.module.css';

const TERMS: { key: string; label: string }[] = [
  { key: '3', label: 'Рассрочка 3 мес' },
  { key: '6', label: 'Рассрочка 6 мес' },
  { key: '12', label: 'Рассрочка 12 мес' },
  { key: '24', label: 'Рассрочка 24 мес' },
];

/**
 * Себестоимость / Реклама — справочники COGS, ставок комиссии и надбавки за рассрочку.
 */
export function CostsPage() {
  const [cogs, setCogs] = useState<CogsRow[]>([]);
  const [commission, setCommission] = useState<CommissionRow[]>([]);
  const [uplift, setUplift] = useState<Record<string, number>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    costsApi.cogs().then((r) => setCogs(r.items)).catch(() => setCogs([]));
    costsApi.commission().then((r) => setCommission(r.items)).catch(() => setCommission([]));
    costsApi.creditUplift().then((r) => setUplift(r.rates)).catch(() => setUplift({}));
  }, []);

  // строковые значения для полей (в процентах), пересобираются при загрузке ставок
  useEffect(() => {
    const e: Record<string, string> = {};
    for (const t of TERMS) e[t.key] = String(Math.round((uplift[t.key] ?? 0) * 1000) / 10);
    setEdits(e);
  }, [uplift]);

  const saveUplift = async (term: string, pctStr: string) => {
    const v = Number(pctStr.replace(',', '.')) / 100;
    if (!Number.isFinite(v) || v < 0) return;
    try {
      await costsApi.setCreditUplift(term, v);
      setUplift((u) => ({ ...u, [term]: v }));
    } catch { /* ignore */ }
  };

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Себестоимость / Реклама</h1>
      </header>

      <div className={styles.grid}>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Себестоимость по SKU</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.left}>Товар</th>
                <th>Категория</th>
                <th>COGS</th>
                <th>Упаковка</th>
              </tr>
            </thead>
            <tbody>
              {cogs.map((c) => (
                <tr key={c.sku}>
                  <td className={styles.left}>
                    <div className={styles.skuName}>{c.name}</div>
                    <div className={styles.skuCode}>{c.sku}</div>
                  </td>
                  <td>{catRu(c.category)}</td>
                  <td>{tenge(c.cogs)}</td>
                  <td>{tenge(c.packaging)}</td>
                </tr>
              ))}
              {cogs.length === 0 && (
                <tr>
                  <td className={styles.empty} colSpan={4}>Нет данных — задайте COGS по SKU</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Ставки комиссии по категориям</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.left}>Категория</th>
                  <th>Ставка</th>
                </tr>
              </thead>
              <tbody>
                {commission.map((c) => (
                  <tr key={c.category}>
                    <td className={styles.left}>{catRu(c.category)}</td>
                    <td>{percent(c.rate)}</td>
                  </tr>
                ))}
                {commission.length === 0 && (
                  <tr>
                    <td className={styles.empty} colSpan={2}>Нет данных — задайте ставки</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Надбавка за рассрочку</h2>
            {TERMS.map((t) => (
              <div key={t.key} className={styles.upliftRow}>
                <span className={styles.upliftLabel}>{t.label}</span>
                <div className={styles.upliftInputWrap}>
                  <input
                    className={styles.upliftInput}
                    type="number"
                    step="0.05"
                    value={edits[t.key] ?? ''}
                    onChange={(e) => setEdits((s) => ({ ...s, [t.key]: e.target.value }))}
                    onBlur={() => saveUplift(t.key, edits[t.key] ?? '')}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                  <span className={styles.upliftSuffix}>%</span>
                </div>
              </div>
            ))}
            <p className={styles.note}>
              Доплата к комиссии за продажу в рассрочку (сверх базовой ставки), по сроку.
              Точные значения — в твоём договоре / кабинете Kaspi. Применяется к части продаж в рассрочку.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
