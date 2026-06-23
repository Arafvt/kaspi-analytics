-- ─────────────────────────────────────────────────────────────
-- Kaspi РНП — схема БД (идемпотентная: CREATE TABLE IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────

-- Товары магазина (мастер-справочник SKU)
CREATE TABLE IF NOT EXISTS sku (
  sku            TEXT PRIMARY KEY,          -- артикул продавца Kaspi (offer.code)
  name           TEXT,
  category_code  TEXT,                      -- категория Kaspi (для ставки комиссии)
  master_code    TEXT,                      -- код мастер-товара Kaspi (для фото/страницы)
  image_url      TEXT,                      -- ссылка на фото (og:image публичной страницы)
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now()
);
-- на случай существующей БД
ALTER TABLE sku ADD COLUMN IF NOT EXISTS master_code TEXT;
ALTER TABLE sku ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Себестоимость и постоянные косты по SKU (ручной ввод)
CREATE TABLE IF NOT EXISTS sku_costs (
  sku            TEXT PRIMARY KEY REFERENCES sku(sku),
  cogs           NUMERIC DEFAULT 0,         -- себест без доставки за единицу, ₸ (закуп×курс)
  cogs_yuan      NUMERIC,                   -- закуп за единицу, ¥
  china_delivery NUMERIC DEFAULT 0,         -- доставка из Китая за единицу, ₸
  packaging      NUMERIC DEFAULT 0,         -- упаковка/маркировка за единицу
  updated_at     TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE sku_costs ADD COLUMN IF NOT EXISTS cogs_yuan NUMERIC;
ALTER TABLE sku_costs ADD COLUMN IF NOT EXISTS china_delivery NUMERIC DEFAULT 0;

-- Ставки комиссии по категориям (справочник, ручной)
CREATE TABLE IF NOT EXISTS category_commission (
  category_code  TEXT PRIMARY KEY,
  rate           NUMERIC NOT NULL,          -- доля, напр. 0.12 = 12%
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Сырые заказы из Kaspi (источник истины для идемпотентного пересчёта)
CREATE TABLE IF NOT EXISTS orders_raw (
  order_code     TEXT,                      -- attributes.code
  entry_number   INTEGER,                   -- номер позиции в заказе
  sku            TEXT,                      -- артикул продавца (из relationship product)
  day            DATE NOT NULL,             -- creationDate -> Asia/Almaty
  sum            NUMERIC DEFAULT 0,         -- entry.totalPrice, ₸
  qty            INTEGER DEFAULT 0,
  delivery_cost  NUMERIC DEFAULT 0,
  status         TEXT,                      -- COMPLETED / RETURNED / ...
  state          TEXT,
  raw            JSONB,                     -- полный attributes на всякий случай
  synced_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (order_code, entry_number)
);
CREATE INDEX IF NOT EXISTS idx_orders_raw_sku_day ON orders_raw(sku, day);
CREATE INDEX IF NOT EXISTS idx_orders_raw_day      ON orders_raw(day);

-- Факт продаж по дням (агрегат, ПЕРЕсобирается из orders_raw)
CREATE TABLE IF NOT EXISTS sales_daily (
  sku            TEXT REFERENCES sku(sku),
  day            DATE,
  orders_sum     NUMERIC DEFAULT 0,         -- выручка ₸ (по продажным заказам дня)
  orders_qty     INTEGER DEFAULT 0,
  returns_sum    NUMERIC DEFAULT 0,
  returns_qty    INTEGER DEFAULT 0,
  delivery_cost  NUMERIC DEFAULT 0,
  PRIMARY KEY (sku, day)
);

-- Рекламные расходы (ручной ввод, ДРР) — нет в API
CREATE TABLE IF NOT EXISTS ad_spend (
  sku            TEXT REFERENCES sku(sku),
  period_month   TEXT,                      -- 'YYYY-MM'
  amount         NUMERIC DEFAULT 0,         -- расходы на рекламу, ₸
  ad_views       NUMERIC DEFAULT 0,         -- показы
  ad_clicks      NUMERIC DEFAULT 0,         -- клики (переходы в карточку)
  ad_orders      NUMERIC DEFAULT 0,         -- заказы с рекламы
  PRIMARY KEY (sku, period_month)
);
ALTER TABLE ad_spend ADD COLUMN IF NOT EXISTS ad_views  NUMERIC DEFAULT 0;
ALTER TABLE ad_spend ADD COLUMN IF NOT EXISTS ad_clicks NUMERIC DEFAULT 0;
ALTER TABLE ad_spend ADD COLUMN IF NOT EXISTS ad_orders NUMERIC DEFAULT 0;

-- Планы продаж по месяцам (ручной ввод)
CREATE TABLE IF NOT EXISTS sales_plan (
  sku            TEXT REFERENCES sku(sku),
  period_month   TEXT,                      -- 'YYYY-MM'
  plan_sum       NUMERIC DEFAULT 0,
  plan_qty       INTEGER DEFAULT 0,
  target_drr     NUMERIC DEFAULT 0,
  plan_profit    NUMERIC DEFAULT 0,         -- план прибыли ₸ (маржа = plan_profit / plan_sum)
  approved       BOOLEAN DEFAULT false,
  PRIMARY KEY (sku, period_month)
);
ALTER TABLE sales_plan ADD COLUMN IF NOT EXISTS plan_profit NUMERIC DEFAULT 0;

-- Глобальные настройки (налог, тарифы)
CREATE TABLE IF NOT EXISTS settings (
  key            TEXT PRIMARY KEY,
  value          TEXT
);

-- Метаданные синка
CREATE TABLE IF NOT EXISTS sync_meta (
  kind           TEXT PRIMARY KEY,          -- 'orders'
  last_run_at    TIMESTAMPTZ,
  last_ok        BOOLEAN,
  last_error     TEXT,
  cursor_ts      BIGINT                     -- докуда выгребли (ms epoch)
);
