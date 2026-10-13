// POST /api/challenge: a one-time value for the app to sign (App Attest) before /api/attest or /api/session.

import { newChallenge, overLimit, reply } from "../../lib/proxy.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return reply(503, { error: "unavailable" });
  const limited = await overLimit(request, env, "auth", 60, 300);
  if (limited) return reply(429, { error: "busy", scope: limited });
  return reply(200, { challenge: await newChallenge(env) });
}
