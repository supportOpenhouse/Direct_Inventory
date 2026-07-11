// Fire-and-forget toast bus. Anything can call toast(); <Toaster/> renders them.
// Kept React-free so the API layer (client.js) can emit without importing UI.
export const TOAST_EVENT = 'app:toast';

export function toast(message, type = 'info', opts = {}) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, type, ...opts } }));
}
