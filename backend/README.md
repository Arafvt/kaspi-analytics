# Backend — Kaspi РНП

Node.js 20 + TypeScript + Fastify + `pg` (node-postgres).

## Структура

```
src/
├── index.ts            # точка входа: Fastify, миграция, запуск sync-loop
├── config/
│   └── env.ts          # чтение .env (единая точка)
├── db/
│   ├── pool.ts         # пул pg, парсеры NUMERIC/BIGINT -> number
│   ├── schema.sql      # идемпотентная схема (CREATE TABLE IF NOT EXISTS)
│   └── migrate.ts      # прогон schema.sql
├── kaspi/
│   ├── types.ts        # типы JSON:API ответов Kaspi
│   └── client.ts       # HTTP-клиент: auth, пагинация, retry/backoff
├── services/
│   ├── sync.ts         # синк Orders -> orders_raw -> sales_daily
│   ├── rnpCalc.ts      # формулы юнит-экономики (чистые функции)
│   └── rnpCalc.test.ts # юнит-тесты формул
└── routes/
    ├── rnp.ts          # /api/rnp/* (unit, plan, daily, sku)
    ├── costs.ts        # /api/costs/* + /api/settings + /api/plan
    └── sync.ts         # /api/sync/orders, /api/sync/status
```

## Команды

```bash
npm install
npm run dev        # tsx watch
npm run migrate    # применить schema.sql
npm test           # vitest (формулы РНП)
npm run typecheck
npm run build && npm start
```

## Статус (что готово / что TODO)

- ✅ Каркас сервиса, конфиг, пул, миграция, маршруты-заглушки
- ✅ Формулы РНП + юнит-тесты (раздел 7 ТЗ)
- ⏳ Фаза 0: сверить на живом магазине форму заказов/позиций и путь к SKU
- ⏳ Фаза 2: маппинг заказов в `orders_raw`, пересборка `sales_daily`
- ⏳ Фаза 3-4: запросы в роутах costs/rnp
```
