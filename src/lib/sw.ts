// Service worker registration with updates that reach a home-screen app.
//
// The browser only checks for a new sw.js on navigation, and iOS resumes a
// home-screen app far more often than it relaunches it, so we also check on
// every return to the foreground (and hourly for a desktop tab left open).
//
// The SW calls skipWaiting(), so a new version takes control as soon as it has
// installed. The page then reloads to run the new code, but never under the
// user's thumb: only on the wallet list, or while the app is in the background.
// A reload on the barcode screen at the till, mid-swipe, is the one thing an
// update must never do.
import { currentRoute, onRouteChange } from './router';

const HOURLY = 60 * 60 * 1000;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  // a first install also fires controllerchange; only an update needs a reload
  const hadController = navigator.serviceWorker.controller != null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadWhenSafe();
  });

  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    // fails while signed out (sw.js sits behind Access) or offline; the next
    // check after signing in picks the update up
    const check = () => { reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    setInterval(check, HOURLY);
  });
}

let reloadPending = false;

function reloadWhenSafe(): void {
  if (reloadPending) return;
  reloadPending = true;
  const safe = () => document.visibilityState === 'hidden' || currentRoute().name === 'wallet';
  if (safe()) return window.location.reload();
  const tryNow = () => { if (safe()) window.location.reload(); };
  onRouteChange(tryNow);
  document.addEventListener('visibilitychange', tryNow);
}
