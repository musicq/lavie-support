import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/session.js';
import { hasAlertAccess } from '../lib/alert.js';

test('only verified paid and active trial tiers can read automatic alerts', () => {
  for (const tier of ['paid', 'trial']) assert.equal(hasAlertAccess(tier), true);
  for (const tier of ['free', 'expired', undefined, null, 'pro']) assert.equal(hasAlertAccess(tier), false);
});

for (const jws of [undefined, 'invalid-proof']) {
  test(`session rejects an alert without a valid Apple subscription proof (${jws ?? 'missing'})`, async () => {
    let created = false;
    function statement(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.startsWith('DELETE FROM challenges')) return { expires: Date.now() + 60_000 };
          throw new Error('Unexpected query: ' + sql);
        },
        async run() {
          if (sql.startsWith('INSERT INTO sessions')) created = true;
          return { results: [{ count: 1 }] };
        }
      };
    }
    const DB = { prepare: statement, async batch(statements) { return Promise.all(statements.map(x => x.run())); } };
    const response = await onRequestPost({
      request: new Request('https://example.test/api/session', { method: 'POST', body: JSON.stringify({
        payload: JSON.stringify({ challenge: 'test', chunks: 1, purpose: 'alert', jws })
      }) }),
      // The subscription gate remains enforced even when App Attest is disabled in local development.
      env: { DB, DEEPSEEK_API_KEY: 'test-only', ENFORCE_ATTEST: '0', ENFORCE_DEVICE: '0' }
    });
    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), { error: 'subscription_required' });
    assert.equal(created, false);
  });
}
