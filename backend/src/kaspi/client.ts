import { config } from '../config/env.js';
import type { JsonApiList, OrderAttributes, OrderEntryAttributes } from './types.js';

/**
 * HTTP-клиент Kaspi Shop API. ТОЛЬКО чтение (GET) — ничего в магазине не меняем.
 *  - X-Auth-Token, JSON:API
 *  - самодросселирование (Kaspi лимиты не публикует): мин. интервал между запросами
 *  - retry с экспон. backoff на 429/5xx, учёт Retry-After
 */

const HEADERS = {
  'X-Auth-Token': config.kaspi.token,
  Accept: 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
};

const MIN_INTERVAL_MS = 150; // ~6-7 запросов/сек (Kaspi лимиты не публикует)
const MAX_RETRIES = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Глобальный «шлюз»: гарантирует паузу между последовательными запросами.
let gateChain: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
  const prev = gateChain;
  gateChain = prev.then(() => sleep(MIN_INTERVAL_MS));
  return prev;
}

async function request<T>(url: string): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (err) {
      // сетевой сбой (fetch failed / ECONNRESET / таймаут) — ретраим
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(1000 * 2 ** attempt, 30_000));
        attempt++;
        continue;
      }
      throw err;
    }

    if (res.ok) return (await res.json()) as T;

    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 30_000);
      await sleep(backoff);
      attempt++;
      continue;
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Kaspi API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
}

export interface OrdersPageParams {
  /**
   * ms epoch — начало окна (creationDate $ge). Эмпирически у Kaspi $ge —
   * начало окна; страницы немного «протекают» назад, поэтому вызывающий код
   * дополнительно фильтрует creationDate >= dateFrom на своей стороне.
   */
  dateFrom: number;
  /**
   * ms epoch — конец окна (creationDate $le). Kaspi отвергает окна шире 14 дней
   * (400 "Exceeded the maximum difference"), поэтому вызывающий код режет период
   * на куски ≤14 дней и задаёт обе границы.
   */
  dateTo?: number;
  pageNumber: number; // с 0
  pageSize?: number; // макс 100
}

/** Одна страница заказов в окне [dateFrom, dateTo]. Kaspi ограничивает окно 14 днями. */
export function getOrdersPage(p: OrdersPageParams): Promise<JsonApiList<OrderAttributes>> {
  const size = p.pageSize ?? config.kaspi.pageSize;
  const qs = [
    `page[number]=${p.pageNumber}`,
    `page[size]=${size}`,
    `filter[orders][creationDate][$ge]=${p.dateFrom}`,
    ...(p.dateTo != null ? [`filter[orders][creationDate][$le]=${p.dateTo}`] : []),
  ].join('&');
  return request<JsonApiList<OrderAttributes>>(`${config.kaspi.base}/v2/orders?${qs}`);
}

/** Позиции заказа (содержат offer.code = SKU и category — товар отдельно не тянем). */
export function getOrderEntries(orderId: string): Promise<JsonApiList<OrderEntryAttributes>> {
  return request<JsonApiList<OrderEntryAttributes>>(
    `${config.kaspi.base}/v2/orders/${orderId}/entries`,
  );
}
