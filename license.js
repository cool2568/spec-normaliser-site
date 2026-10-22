// Pro licensing with Dodo Payments license keys, checked from the browser. No server and no API key: Dodo's
// activate, validate and deactivate endpoints are public. Pure: fetch, the clock and storage are passed in, so
// the Node tests need no browser. https://docs.dodopayments.com/api-reference/licenses/activate-license
// ponytail: honour system. Anyone can edit localStorage; only a server could enforce Pro, and this page has none.

export const BILLING = { freeBeta: true, apiBase: 'https://test.dodopayments.com', checkoutUrl: 'DODO_CHECKOUT_URL', freeLimit: 3 };

const DAY = 864e5;
const FREE = { key: '', instanceId: '', validatedAt: 0, status: 'free' };
// Why Dodo refuses an activation: its 403, 404 and 422.
const REFUSED = { 403: 'this key is not active', 404: 'no such license key', 422: 'this key is active in too many browsers; remove it from one first' };

/**
 * This browser's Pro license, kept under localStorage "license" as { key, instanceId, validatedAt, status: 'pro'|'free' }.
 * @param {{ fetch: typeof fetch, now: () => number, storage: { get(k: string): string|null, set(k: string, v: string): void } }} deps
 */
export function license({ fetch, now, storage }) {
  // Timed out after 10 s: the first drop waits for check(), and a hung request would hold it up for minutes.
  const post = (path, body) => fetch(`${BILLING.apiBase}/licenses/${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout?.(10e3) });
  // localStorage throws in some private windows and when site data is blocked: that counts as free.
  const load = () => {
    try {
      return { ...FREE, ...JSON.parse(storage.get('license')) };
    } catch {
      return FREE;
    }
  };
  const save = (s) => {
    try {
      storage.set('license', JSON.stringify(s));
      return s;
    } catch {
      return FREE;
    }
  };
  return {
    /** Pro from now on, or throws with Dodo's reason. */
    async activate(key) {
      key = key.trim();
      const res = await post('activate', { license_key: key, name: 'browser' });
      if (!res.ok) throw new Error(REFUSED[res.status] ?? `Dodo Payments answered ${res.status}`);
      // ponytail: where storage throws, the activation is used up all the same; probe storage first if that bites.
      return save({ key, instanceId: (await res.json()).id, validatedAt: now(), status: 'pro' });
    },
    /** The plan, re-validated once the last validation is over 7 days old. Offline, Pro lasts 14 days from it. */
    async check() {
      const s = load();
      if (!s.key || now() - s.validatedAt <= 7 * DAY) return s;
      try {
        const res = await post('validate', { license_key: s.key, license_key_instance_id: s.instanceId });
        if (!res.ok) throw new Error(res.status); // a server error is no verdict on the key
        return save((await res.json()).valid ? { ...s, validatedAt: now(), status: 'pro' } : FREE);
      } catch {
        return save({ ...s, status: now() - s.validatedAt <= 14 * DAY ? 'pro' : 'free' }); // the key stays, to retry
      }
    },
    /** Forgets the key here, then frees its activation; throws when Dodo didn't free it. */
    async remove() {
      const { key, instanceId } = load();
      save(FREE);
      if (!key) return FREE;
      const res = await post('deactivate', { license_key: key, license_key_instance_id: instanceId });
      if (!res.ok) throw new Error(`Dodo Payments answered ${res.status}`);
      return FREE;
    },
  };
}
