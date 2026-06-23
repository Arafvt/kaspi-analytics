# Kaspi РНП

Сервис расчёта **РНП** (план продаж + юнит-экономика) для магазина на Kaspi.kz.

Тянет заказы из Kaspi Shop API, считает выручку/выкупы/прибыль/маржу/ДРР по SKU,
соединяет с себестоимостью и рекламой, показывает дашборд, юнит-экономику и план/факт.
MVP — **только аналитика** (без управления товарами/ценами/отзывами).

## Стек

| Слой       | Технология                                     |
|------------|------------------------------------------------|
| Backend    | Node.js 20 + TypeScript + Fastify + `pg`       |
| БД         | PostgreSQL 16                                  |
| Frontend   | React 18 + TypeScript + Vite + CSS Modules     |
| Инфра      | Docker Compose (postgres + backend + frontend) |
| Синк       | фоновый `setInterval` loop по Kaspi Shop API   |

## Структура

```
.
├── docker-compose.yml      # postgres + backend + frontend (project name: kaspi-rnp)
├── .env                    # секреты и настройки (из .env.example)
├── data/                   # выгрузки для импорта: себестоимость (.xlsx) + реклама (.csv)
├── reference/              # справочные материалы (логика 10X)
├── backend/                # API + синк Kaspi + движок РНП
│   └── src/
│       ├── kaspi/          # HTTP-клиент Kaspi Shop API (троттлинг, ретраи)
│       ├── services/       # синк заказов, движок расчёта РНП, сборка дашборда
│       ├── routes/         # /api/rnp/*, /api/costs/*, /api/sync/*
│       ├── scripts/        # импорт себеса/рекламы, обогащение фото, ручной синк
│       └── db/             # schema.sql + миграция
└── frontend/               # React + Vite
    └── src/
        ├── components/     # переиспользуемые (FilterBar, ProductTable…)
        ├── pages/          # Dashboard, Unit, Plan, Costs
        └── utils/          # формат чисел, словарь категорий (catRu)
```

## Запуск

```bash
cp .env.example .env        # вписать KASPI_API_TOKEN
docker compose up -d --build
```

- Frontend: http://localhost:5173
- Backend:  http://localhost:8080
- Postgres: **localhost:5433** (хост 5433 → контейнер 5432, чтобы не конфликтовать с нативным PG)

## Синхронизация заказов

Backend при старте запускает фоновый синк (`KASPI_SYNC_INTERVAL`, по умолчанию час).
Kaspi ограничивает фильтр `creationDate` **14 днями за запрос**, поэтому окно
`[курсор, сейчас]` режется на куски ≤13 дней. Сырьё кладётся в `orders_raw` (идемпотентный
UPSERT), агрегат `sales_daily` пересобирается из сырья — двойного счёта нет.

Ручной бэкфилл с конкретной даты (с хоста, БД на `localhost:5433`):

```bash
cd backend
npx tsx src/scripts/runSync.ts 2026-06-01   # тянуть с даты
npx tsx src/scripts/runSync.ts 7            # тянуть за N дней
```

## Импорт справочных данных (папка `data/`)

Порядок важен — реклама привязывается по `sku.master_code`, который заполняет enrich:

```bash
cd backend
npx tsx src/scripts/enrichImages.ts          # master_code + фото товаров (Kaspi)
npx tsx src/scripts/importCosts.ts           # себестоимость из data/Book1*.xlsx → sku_costs
npx tsx src/scripts/importAds.ts 2026-06     # реклама из data/*Отчёт по товарам*.csv → ad_spend
```

## Страницы

- **Дашборд** — план/прогноз/факт месяца, динамика по дням, таблица товаров (с группировкой).
- **Юнит-экономика** — полная разбивка расходов и маржи по каждому SKU.
- **План** — ввод плана выручки/штук/ДРР/прибыли/маржи по SKU → попадает в дашборд.
- **Косты** — себестоимость, курс ¥, ставки комиссии по категориям.

## Переменные окружения (`.env`)

| Переменная             | Назначение                                       |
|------------------------|--------------------------------------------------|
| `KASPI_API_TOKEN`      | X-Auth-Token из кабинета продавца (Настройки→API)|
| `KASPI_SYNC_INTERVAL`  | период фонового синка, сек                       |
| `KASPI_BACKFILL_DAYS`  | глубина холодного бэкфилла при пустом курсоре    |
| `POSTGRES_USER/PASSWORD/DB` | доступы к БД                                |
| `DATABASE_URL`         | строка подключения backend → postgres            |
| `TAX_RATE_DEFAULT`     | ставка налога по умолчанию (доля)                |
