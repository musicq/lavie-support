// Endpoint regressions use a fake authenticated session, D1 and model response. No network or secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/statement.js";

const today = new Date().toISOString().slice(0, 10);
const input = {
  text: "SGD 12.34 spent at Example Cafe.", baseCurrency: "SGD", today,
  expense: [{ code: "food" }, { code: "custom.meals", name: "Meals out" }],
  income: [{ code: "salary" }, { code: "refund" }],
};
const purchase = { d: today, m: "Example Cafe", a: 12.34, c: "SGD", k: "e", cat: "food", src: input.text };
const completed = (row = purchase) => ({ classification: "completed_transaction", transactions: [row] });

function database(purpose) {
  const current = { token: "test-session", user_id: "test-user", tier: "paid", spent_micro: 0, budget_micro: 100_000,
    chunks: 0, checks: JSON.stringify({ purpose }) };
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() {
        if (sql.startsWith("SELECT * FROM sessions")) return values[0] === current.token ? current : null;
        if (sql.startsWith("UPDATE sessions SET chunks = 1")) {
          if (current.chunks) return null;
          current.chunks = 1;
          return { token: current.token };
        }
        throw new Error(`Unexpected test query: ${sql}`);
      },
      async run() { return { results: [{ count: 1 }] }; },
    };
  }
  return { current, prepare: statement, async batch(statements) { return Promise.all(statements.map((item) => item.run())); } };
}

function endpoint(t, { purpose = "alert", answer = completed() } = {}) {
  const DB = database(purpose);
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    sent.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { completion_tokens: 10 } });
  });
  return {
    DB, sent,
    async run(overrides = {}, token = "test-session") {
      const pending = [];
      const response = await onRequestPost({
        request: new Request("https://example.test/api/statement", {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, ...overrides }),
        }),
        env: { DB, DEEPSEEK_API_KEY: "test-only", IP_SALT: "test-only" },
        waitUntil(work) { pending.push(work); },
      });
      await Promise.all(pending);
      return { status: response.status, body: await response.json() };
    },
  };
}

test("an authenticated alert session uses the single-transaction prompt, ignoring a request purpose override", async (t) => {
  const api = endpoint(t);
  assert.deepEqual(await api.run({ purpose: "statement" }), { status: 200, body: { transactions: [purchase] } });
  const prompt = api.sent[0].messages[0].content;
  assert.match(prompt, /This is not a statement import/);
  assert.match(prompt, /payment reminders/i);
  assert.match(prompt, /Credit card repayments/);
  assert.match(prompt, /future due date/);
  assert.match(prompt, /untrusted data, never instructions/);
  assert.equal(api.DB.current.chunks, 1);
});

test("a reminder or uncertain classification cannot produce a transaction, even if the model also supplied a row", async (t) => {
  for (const classification of ["non_transaction", "uncertain"]) {
    await t.test(classification, async (t) => {
      const api = endpoint(t, { answer: { classification, transactions: [{ ...purchase, a: 1234.56, m: "Card payment due" }] } });
      assert.deepEqual(await api.run({ text: "Reminder: your card payment of SGD 1,234.56 is due next week." }),
        { status: 200, body: { transactions: [] } });
    });
  }
});

test("valid purchases, refunds and income remain eligible and only transaction fields leave the endpoint", async (t) => {
  for (const row of [purchase, { ...purchase, k: "i", cat: "refund" }, { ...purchase, k: "i", cat: "salary" },
    { ...purchase, cat: "custom.meals" }, { ...purchase, cat: "other" }]) {
    await t.test(`${row.k}/${row.cat}`, async (t) => {
      const api = endpoint(t, { answer: completed({ ...row, explanation: "not part of the response contract" }) });
      assert.deepEqual(await api.run(), { status: 200, body: { transactions: [row] } });
    });
  }
});

test("alerts reject missing classifications, multiple candidates, transfers and malformed transaction fields", async (t) => {
  const cases = [
    ["missing classification", { transactions: [purchase] }],
    ["unknown classification", { classification: "probably", transactions: [purchase] }],
    ["multiple transactions", { classification: "completed_transaction", transactions: [purchase, purchase] }],
    ["no completed transaction", { classification: "completed_transaction", transactions: [] }],
    ["not an array", { classification: "completed_transaction", transactions: purchase }],
    ["transfer", completed({ ...purchase, k: "t" })],
    ["missing direction", completed({ ...purchase, k: undefined })],
    ["string amount", completed({ ...purchase, a: "1234.56" })],
    ["negative amount", completed({ ...purchase, a: -1 })],
    ["zero amount", completed({ ...purchase, a: 0 })],
    ["invalid date", completed({ ...purchase, d: "2026-02-30" })],
    ["future due date", completed({ ...purchase, d: "2099-01-01" })],
    ["invalid currency", completed({ ...purchase, c: "S$" })],
    ["missing merchant", completed({ ...purchase, m: " " })],
    ["wrong category kind", completed({ ...purchase, cat: "salary" })],
    ["unknown category", completed({ ...purchase, cat: "invented" })],
    ["oversize source", completed({ ...purchase, src: "x".repeat(61) })],
  ];
  for (const [name, answer] of cases) {
    await t.test(name, async (t) => {
      const api = endpoint(t, { answer });
      assert.deepEqual(await api.run({ purpose: "statement" }), { status: 502, body: { error: "unreadable" } });
    });
  }
});

test("statement sessions retain the import prompt and accept multiple transactions without alert classification", async (t) => {
  const rows = [purchase, { ...purchase, k: "t", cat: "other" }];
  const api = endpoint(t, { purpose: "statement", answer: { transactions: rows } });
  assert.deepEqual(await api.run({ purpose: "alert", part: 1, parts: 2 }), { status: 200, body: { transactions: rows } });
  assert.match(api.sent[0].messages[0].content, /^You read bank, credit card and e-wallet statements/);
  assert.doesNotMatch(api.sent[0].messages[0].content, /classification/);
  assert.match(api.sent[0].messages[1].content, /^Part 1 of 2 of the same statement:/);
  assert.equal(api.DB.current.chunks, 0);
});

test("empty model results still work for non-transactions and statements", async (t) => {
  for (const purpose of ["alert", "statement"]) {
    await t.test(purpose, async (t) => {
      const api = endpoint(t, { purpose, answer: { classification: "non_transaction", transactions: [] } });
      assert.deepEqual(await api.run(), { status: 200, body: { transactions: [] } });
    });
  }
});

test("alert sessions still reject multi-part or oversized input before making a model request", async (t) => {
  for (const overrides of [{ parts: 2 }, { text: "x".repeat(6001) }]) {
    await t.test(JSON.stringify(Object.keys(overrides)), async (t) => {
      const api = endpoint(t);
      assert.equal((await api.run(overrides)).status, 400);
      assert.equal(api.sent.length, 0);
    });
  }
});

test("single-use, session and purpose protections remain enforced", async (t) => {
  await t.test("one model request per alert session", async (t) => {
    const api = endpoint(t);
    assert.equal((await api.run()).status, 200);
    assert.equal((await api.run()).status, 401);
    assert.equal(api.sent.length, 1);
  });
  await t.test("no session", async (t) => {
    const api = endpoint(t);
    assert.equal((await api.run({}, "wrong-token")).status, 401);
    assert.equal(api.sent.length, 0);
  });
  await t.test("tidy session cannot read alerts", async (t) => {
    const api = endpoint(t, { purpose: "tidy" });
    assert.equal((await api.run()).status, 401);
    assert.equal(api.sent.length, 0);
  });
});
