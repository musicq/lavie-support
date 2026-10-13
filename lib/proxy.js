// Shared pieces of the /api endpoints: replies, request counting, challenges, sessions, costs.

import { sha256, toBase64 } from "./apple.js";

export const PRODUCTS = ["com.lifebar.pro.monthly", "com.lifebar.pro.annual"];
export const appId = (env) => `${env.APPLE_TEAM_ID}.${env.BUNDLE_ID}`;
export const enforced = (env) => env.ENFORCE === "1";

/// DeepSeek V4.1 Flash list prices at peak, USD per million tokens (off-peak is half;
/// counting peak keeps the caps on the safe side).
const PRICE = { hit: 0.006, miss: 0.3, output: 1.2 };
/// Cost of one call in millionths of a dollar.
export function costMicro(usage = {}) {
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  return Math.ceil(hit * PRICE.hit + miss * PRICE.miss + (usage.completion_tokens ?? 0) * PRICE.output);
}

export function caps(env) {
  return {
    paid: Number(env.CAP_PAID_MICRO || 50_000),
    trial: Number(env.CAP_TRIAL_MICRO || 20_000),
    free: Number(env.CAP_FREE_MICRO || 50_000),
  };
}

export function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function json(request) {
  try {
    const body = await request.json();
    if (typeof body === "object" && body !== null) return body;
  } catch {}
  return null;
}

export const today = () => new Date().toISOString().slice(0, 10);

export function token(bytes = 32) {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64(random).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/// A salted hash of the caller's address that changes every day.
export async function addressHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await sha256(new TextEncoder().encode(`${env.IP_SALT || "lavie"}|${today()}|${ip}`));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// Counts this request for its address under `kind` and says which limit it went over, if any.
/// Counts older than two days are removed on the way.
export async function overLimit(request, env, kind, perHour, perDay, everyone = 0) {
  const now = new Date();
  const day = today();
  const hour = now.toISOString().slice(0, 13);
  const who = await addressHash(request, env);
  const statement = env.DB.prepare(
    "INSERT INTO usage (bucket, day, count) VALUES (?1, ?2, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count"
  );
  const count = (result) => result.results?.[0]?.count ?? 0;
  const expired = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const [inHour, inDay] = await env.DB.batch([
    statement.bind(`${kind}:${who}:${hour}`, day),
    statement.bind(`${kind}:${who}:${day}`, day),
    env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(expired),
  ]);
  if (count(inHour) > perHour) return "hour";
  if (count(inDay) > perDay) return "day";
  if (!everyone) return null;
  // Only requests that pass their own limits count toward everyone's.
  const all = await statement.bind(`all:${day}`, day).run();
  return count(all) > everyone ? "all" : null;
}

export async function newChallenge(env) {
  const value = token();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires < ?1").bind(now),
    env.DB.prepare("INSERT INTO challenges (id, expires) VALUES (?1, ?2)").bind(value, now + 5 * 60_000),
  ]);
  return value;
}

/// A challenge works once, within five minutes.
export async function useChallenge(env, value) {
  if (typeof value !== "string" || value.length > 100) return false;
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id = ?1 RETURNING expires").bind(value).first();
  return !!row && row.expires >= Date.now();
}

export async function session(request, env) {
  const value = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!value) return null;
  return env.DB.prepare("SELECT * FROM sessions WHERE token = ?1 AND expires >= ?2").bind(value, Date.now()).first();
}
