// The device-local "shown" marker: which vouchers had their barcode on screen,
// and when. Never synced, never a server event — it exists so you can tell
// five identical 20,00 € vouchers apart at the till.
const KEY = 'till:shown';

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}

export function markShown(voucherId: string): void {
  const map = load();
  map[voucherId] = new Date().toISOString();
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function shownAt(voucherId: string): string | null {
  return load()[voucherId] ?? null;
}

/** "9:38"-style local time for the pill. */
export function shownLabel(voucherId: string): string | null {
  const iso = shownAt(voucherId);
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function clearShown(voucherId: string): void {
  const map = load();
  delete map[voucherId];
  localStorage.setItem(KEY, JSON.stringify(map));
}
