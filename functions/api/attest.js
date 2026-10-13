// POST /api/attest {keyId, attestation, challenge}: registers a new App Attest key for this install.
// Until ENFORCE is "1" a key that fails the check is only logged, so a bug here can't stop imports.

import { verifyAttestation } from "../../lib/apple.js";
import { appId, enforced, json, overLimit, reply, useChallenge } from "../../lib/proxy.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return reply(503, { error: "unavailable" });
  const limited = await overLimit(request, env, "auth", 60, 300);
  if (limited) return reply(429, { error: "busy", scope: limited });

  const body = await json(request);
  const { keyId, attestation, challenge } = body || {};
  if (typeof keyId !== "string" || keyId.length > 100 || typeof attestation !== "string" || attestation.length > 20_000) {
    return reply(400, { error: "bad_request" });
  }
  if (!(await useChallenge(env, challenge))) return reply(400, { error: "challenge" });

  try {
    const key = await verifyAttestation({ keyId, attestation, challenge, appId: appId(env) });
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO app_keys (key_id, public_key, counter, environment, created_at, last_seen) VALUES (?1, ?2, 0, ?3, ?4, ?4)"
    ).bind(keyId, key.publicKey, key.environment, now).run();
    console.log(JSON.stringify({ event: "attest", ok: true, environment: key.environment }));
    return reply(200, { stored: true });
  } catch (error) {
    console.log(JSON.stringify({ event: "attest", ok: false, error: String(error.message || error) }));
    return enforced(env) ? reply(403, { error: "unverified" }) : reply(200, { stored: false });
  }
}
