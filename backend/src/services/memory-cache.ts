interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function memGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function memSet<T>(key: string, value: T, ttlSeconds: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function memDel(key: string): void {
  store.delete(key);
}

export function memDeletePattern(pattern: string): void {
  const regex = globToRegExp(pattern);
  for (const key of store.keys()) {
    if (regex.test(key)) {
      store.delete(key);
    }
  }
}

export function memClear(): void {
  store.clear();
}

export function memSize(): number {
  return store.size;
}
