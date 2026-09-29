export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as T | { error?: string };
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}
