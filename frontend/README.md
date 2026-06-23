# Frontend — Kaspi РНП

React 18 + TypeScript + Vite. Стили — **CSS Modules** (`*.module.css`),
один компонент = одна папка с co-located стилями.

## Структура

```
src/
├── main.tsx                # точка входа, роутер
├── App.tsx                 # маршруты + Layout
├── api/
│   ├── client.ts           # обёртка fetch
│   └── rnp.ts              # вызовы /api/rnp/*
├── types/
│   └── rnp.ts              # типы (зеркало backend)
├── utils/
│   └── format.ts           # тенге / % / шт / уровень маржи
├── components/
│   └── Layout/
│       ├── Layout.tsx
│       └── Layout.module.css
├── pages/
│   ├── UnitPage/           # UNIT — юнит-экономика по SKU
│   ├── PlanPage/           # ПЛАН — план/факт по месяцам
│   └── CostsPage/          # ввод COGS / комиссий / рекламы
└── styles/
    └── global.css          # CSS-переменные (тема), reset
```

## Конвенции

- Каждый компонент/страница — **папка** `Name/` с `Name.tsx` + `Name.module.css`.
- Импорт стилей: `import styles from './Name.module.css'` → `className={styles.foo}`.
- Классы в camelCase (`localsConvention: camelCaseOnly`).
- Цвета/отступы — только через CSS-переменные из `styles/global.css`.
- Алиас путей: `@/` → `src/`.

## Команды

```bash
npm install
npm run dev        # http://localhost:5173 (API проксируется на :8080)
npm run build
npm run typecheck
```
