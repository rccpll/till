// Three-screen router on pushState so iOS swipe-back works in the PWA.
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'wallet' }
  | { name: 'upload' }
  | { name: 'barcode'; id: string }
  | { name: 'details'; id: string };

function parse(path: string): Route {
  if (path === '/upload') return { name: 'upload' };
  const details = path.match(/^\/v\/([^/]+)\/details$/);
  if (details) return { name: 'details', id: details[1] };
  const barcode = path.match(/^\/v\/([^/]+)$/);
  if (barcode) return { name: 'barcode', id: barcode[1] };
  return { name: 'wallet' };
}

const listeners = new Set<() => void>();
let current: Route = parse(window.location.pathname);

window.addEventListener('popstate', () => {
  current = parse(window.location.pathname);
  for (const l of listeners) l();
});

export function navigate(path: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  current = parse(path);
  for (const l of listeners) l();
}

export function back(): void {
  // if the app was launched straight onto a deep screen there is no history
  if (window.history.length > 1) window.history.back();
  else navigate('/', true);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}
