/**
 * Типы ответов Kaspi Shop API (JSON:API), сверены на живом магазине (Фаза 0).
 * Данные: { data: [...], included: [...], links, meta }.
 * Ресурс: { type, id, attributes, relationships }.
 */

export interface JsonApiResource<A> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, { links?: { related?: string }; data?: unknown }>;
}

export interface JsonApiList<A> {
  data: JsonApiResource<A>[];
  included?: JsonApiResource<unknown>[];
  links?: { self?: string; next?: string; prev?: string; first?: string; last?: string };
  meta?: { totalCount?: number; pageCount?: number; [k: string]: unknown };
}

// ── Заказ (GET /api/v2/orders) ────────────────────────────────
export interface OrderAttributes {
  code: string; // номер заказа
  creationDate: number; // ms epoch
  totalPrice: number;
  deliveryCostForSeller?: number; // доставка за счёт продавца
  deliveryCost?: number;
  isKaspiDelivery?: boolean;
  status: string; // APPROVED_BY_BANK / ACCEPTED_BY_MERCHANT / COMPLETED / CANCELLED / RETURNED
  state: string; // NEW / SIGN_REQUIRED / PICKUP / DELIVERY / KASPI_DELIVERY / ARCHIVE
  paymentMode?: string;
  deliveryMode?: string;
  completionDate?: number;
  [k: string]: unknown;
}

// ── Позиция заказа (GET /api/v2/orders/{id}/entries) ──────────
// На живом магазине позиция уже содержит offer (SKU продавца) и category —
// отдельный запрос за товаром НЕ нужен.
export interface OrderEntryAttributes {
  entryNumber: number;
  quantity: number;
  basePrice: number;
  totalPrice: number;
  deliveryCost?: number;
  unitType?: string;
  category?: { code: string; title: string };
  offer?: { code: string; name: string }; // code = SKU продавца
  isImeiRequired?: boolean;
  [k: string]: unknown;
}
