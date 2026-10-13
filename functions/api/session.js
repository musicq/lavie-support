// POST /api/session {payload, keyId?, assertion?}: starts one import.
//
// payload is a JSON string the app signed with its App Attest key:
//   {challenge, chunks, purpose: "statement" | "alert", jws?, deviceToken?, sandbox?}
// - Lavie Plus is proven by a StoreKit transaction (jws), and counted per originalTransactionId,
//   so it is one person on iPhone and iPad alike.
// - Without Plus, a statement import needs DeviceCheck: the app allows one per payday cycle,
//   the server FREE_IMPORTS_PER_MONTH per device per calendar month (cycles and months don't
//   line up), counted in DeviceCheck's two bits so a reinstall doesn't reset it. Reading one bank
//   alert (purpose "alert") only spends from the daily budget.
// - Each person has a daily AI budget; a session gets what is left of it (at least one statement).
// Until ENFORCE is "1", failed App Attest and DeviceCheck checks are logged but not refused.

import { freeImportsThisMonth, verifyAssertion, verifyTransaction } from "../../lib/apple.js";
import { PRODUCTS, addressHash, appId, caps, enforced, json, overLimit, reply, today, token, useChallenge } from "../../lib/proxy.js";

// Millionths of a dollar at peak prices: a dense 9,000-character chunk, and one bank alert.
const ESTIMATE = { statement: 10_000, alert: 1_000 };

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.DEEPSEEK_API_KEY) return reply(503, { error: "unavailable" });
  const limited = await overLimit(request, env, "auth", 60, 300);
  if (limited) return reply(429, { error: "busy", scope: limited });

  const body = await json(request);
  let payload;
  try {
    payload = JSON.parse(body?.payload);
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const chunks = payload?.chunks;
  if (typeof body.payload !== "string" || body.payload.length > 20_000 || !Number.isInteger(chunks) || chunks < 1 || chunks > 40) {
    return reply(400, { error: "bad_request" });
  }
  if (!(await useChallenge(env, payload.challenge))) return reply(400, { error: "challenge" });
  const sandbox = payload.sandbox === true;
  const purpose = payload.purpose === "alert" ? "alert" : "statement";
  const checks = {};

  // 1. The genuine app on a real device.
  const { keyId, assertion } = body;
  if (typeof keyId === "string" && typeof assertion === "string" && assertion.length < 10_000) {
    const key = await env.DB.prepare("SELECT * FROM app_keys WHERE key_id = ?1").bind(keyId).first();
    if (!key) checks.attest = "unknown key";
    else {
      try {
        const counter = await verifyAssertion({
          assertion,
          clientData: new TextEncoder().encode(body.payload),
          publicKey: key.public_key,
          counter: key.counter,
          appId: appId(env),
        });
        await env.DB.prepare("UPDATE app_keys SET counter = ?2, last_seen = ?3 WHERE key_id = ?1")
          .bind(keyId, counter, new Date().toISOString()).run();
        checks.attest = "ok";
      } catch (error) {
        checks.attest = String(error.message || error);
      }
    }
  } else checks.attest = "missing";
  const attested = checks.attest === "ok";
  if (enforced(env) && !attested) return finish(403, { error: "unverified" }, checks);

  // 2. Who it is.
  let user, tier, product = null, environment = null, deviceToken = null, freeUsed = null;
  if (typeof payload.jws === "string" && payload.jws.length < 10_000) {
    try {
      const transaction = await verifyTransaction(payload.jws, { bundleId: env.BUNDLE_ID, products: PRODUCTS });
      user = `tx:${transaction.originalTransactionId}`;
      tier = transaction.trial ? "trial" : "paid";
      product = transaction.productId;
      environment = transaction.environment;
      checks.jws = "ok";
    } catch (error) {
      checks.jws = String(error.message || error);
    }
  }
  if (!user) {
    tier = "free";
    user = attested ? `key:${keyId}` : `ip:${await addressHash(request, env)}`;
    if (purpose === "statement") {
      if (typeof payload.deviceToken === "string" && payload.deviceToken.length < 10_000 && env.DEVICECHECK_KEY) {
        deviceToken = payload.deviceToken;
        try {
          freeUsed = await freeImportsThisMonth(env, deviceToken, sandbox);
          checks.device = `used ${freeUsed}`;
        } catch (error) {
          checks.device = String(error.message || error);
        }
      } else checks.device = "missing";
      if (enforced(env) && freeUsed === null) return finish(403, { error: "unverified" }, checks);
      if (enforced(env) && freeUsed >= Number(env.FREE_IMPORTS_PER_MONTH || 2)) return finish(402, { error: "trial_used" }, checks);
    }
  }

  // 3. What they may spend today.
  const cap = caps(env)[tier];
  const day = today();
  const spent = (await env.DB.prepare("SELECT cost_micro FROM usage_daily WHERE user_id = ?1 AND day = ?2").bind(user, day).first())?.cost_micro ?? 0;
  const estimate = chunks * ESTIMATE[purpose];
  // The first statement of the day always fits, whatever its size; after that, what's left of the cap.
  if (spent > 0 && spent + estimate > cap) return finish(429, { error: "daily_limit" }, { ...checks, tier });

  const now = new Date().toISOString();
  const value = token();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, tier, product, environment, first_seen, last_seen, imports) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)
       ON CONFLICT(id) DO UPDATE SET tier = ?2, product = COALESCE(?3, product), environment = COALESCE(?4, environment), last_seen = ?5, imports = imports + 1`
    ).bind(user, tier, product, environment, now),
    env.DB.prepare(
      `INSERT INTO sessions (token, user_id, tier, expires, budget_micro, device_token, device_count, sandbox, checks, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(value, user, tier, Date.now() + 30 * 60_000, Math.max(cap - spent, estimate), freeUsed === null ? null : deviceToken, freeUsed, sandbox ? 1 : 0, JSON.stringify({ purpose, ...checks }), now),
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?1").bind(Date.now() - 86_400_000),
  ]);
  return finish(200, { token: value, tier }, { ...checks, tier, purpose });
}

function finish(status, body, checks) {
  console.log(JSON.stringify({ event: "session", status, ...checks }));
  return reply(status, body);
}
