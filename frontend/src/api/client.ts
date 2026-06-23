/** Тонкая обёртка над fetch. В dev проксируется на :8080 (vite.config). */

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => http<T>(url),
  post: <T>(url: string, body: unknown) =>
    http<T>(url, { method: 'POST', body: JSON.stringify(body) }),
};
