import { useEffect, useState } from 'react';
import { tenge, percent } from '../../utils/format';
import { costsApi, type CogsRow, type CommissionRow } from '../../api/rnp';
import styles from './CostsPage.module.css';

/**
 * Себестоимость / Реклама — справочники COGS и ставок комиссии.
 * Данные из API; на Фазе 3 поля станут редактируемыми (POST /api/costs/*).
 */
export function CostsPage() {
  const [cogs, setCogs] = useState<CogsRow[]>([]);
  const [commission, setCommission] = useState<CommissionRow[]>([]);

  useEffect(() => {
    costsApi.cogs().then((r) => setCogs(r.items)).catch(() => setCogs([]));
    costsApi.commission().then((r) => setCommission(r.items)).catch(() => setCommission([]));
  }, []);

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
                  <td>{c.category}</td>
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
                  <td className={styles.left}>{c.category}</td>
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
          <p className={styles.note}>
            ДРР (реклама) и налог вводятся отдельно — нет в Kaspi API.
          </p>
        </div>
      </div>
    </section>
  );
}
