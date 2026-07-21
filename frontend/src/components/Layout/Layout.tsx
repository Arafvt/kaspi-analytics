import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import styles from './Layout.module.css';

const NAV = [
  { to: '/dashboard', label: 'Дашборд' },
  { to: '/unit', label: 'UNIT' },
  { to: '/plan', label: 'ПЛАН' },
  { to: '/analytics', label: 'Аналитика' },
  { to: '/costs', label: 'Себестоимость / Реклама' },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>Kaspi РНП</div>
        <nav className={styles.nav}>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
