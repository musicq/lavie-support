// POST /api/statement: reads one chunk of a bank statement with DeepSeek for the Lavie app.
//
// The DeepSeek key lives only here (the DEEPSEEK_API_KEY secret). The app sends the
// statement text and the person's categories with a session token from /api/session; the
// prompt, model and output limit are fixed below, so this can't be used as a general-purpose
// DeepSeek endpoint. Each call's real cost is added to the person's day; a session stops at its
// budget. Requests are also counted per (hashed) IP and for everyone per day, which bounds the
// bill whatever happens.

import { setFreeImportsThisMonth } from "../../lib/apple.js";
import { alertPrompt, alertTransactions } from "../../lib/alert.js";
import { claimSingleUse, costMicro, overLimit, purposeOf, reply, session, today } from "../../lib/proxy.js";

const MODEL = "deepseek-flash";
const MAX_TEXT = 12_000; // UTF-16 units; the app sends chunks of 9,000 characters.
// One bank alert, SMS or card email: the app sends at most 4,000 characters of it.
const MAX_ALERT_TEXT = 6_000;
const MAX_CATEGORIES = 80;

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DEEPSEEK_API_KEY || !env.DB) return reply(503, { error: "unavailable" });

  const current = await session(request, env);
  if (!current) return reply(401, { error: "session" });
  // Alert and tidy sessions skip the free-import check: a tidy one can't read here at all, an
  // alert one reads one short text, once. A statement goes through a statement session.
  const purpose = purposeOf(current);
  if (purpose === "tidy") return reply(401, { error: "session" });
  if (current.spent_micro >= current.budget_micro) return reply(429, { error: "daily_limit" });

  let input;
  try {
    input = validate(await request.json());
    if (purpose === "alert" && (input.text.length > MAX_ALERT_TEXT || input.parts > 1)) throw new Error("alert text");
  } catch (error) {
    return reply(400, { error: "bad_request", detail: String(error.message || error) });
  }
  const single = purpose === "alert";
  if (single && !(await claimSingleUse(env, current))) return reply(401, { error: "session" });

  const limited = await overLimit(request, env, "ip", Number(env.LIMIT_IP_HOUR || 40), Number(env.LIMIT_IP_DAY || 150), Number(env.LIMIT_ALL_DAY || 4000));
  if (limited) return reply(429, { error: "busy", scope: limited });

  const user = input.parts > 1 ? `Part ${input.part} of ${input.parts} of the same statement:\n\n${input.text}` : input.text;
  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        // Thinking is on by default; for this job it costs more and is slower without finding more.
        thinking: { type: "disabled" },
        temperature: 0,
        // A dense 9,000-character chunk can list 180 rows at ~70 tokens each.
        max_tokens: 16_000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: single ? alertPrompt(input) : systemPrompt(input) },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    return reply(502, { error: "upstream" });
  }
  if (!response.ok) return reply(502, { error: "upstream", status: response.status });

  const envelope = await response.json().catch(() => null);
  waitUntil(record(env, current, costMicro(envelope?.usage), single));
  const content = envelope?.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return reply(502, { error: "unreadable" });
  }
  if (!Array.isArray(parsed?.transactions)) return reply(502, { error: "unreadable" });
  if (single) {
    const transactions = alertTransactions(parsed, input);
    if (transactions === null) return reply(502, { error: "unreadable" });
    return reply(200, { transactions });
  }
  return reply(200, { transactions: parsed.transactions });
}

function validate(body) {
  if (typeof body !== "object" || body === null) throw new Error("body");
  const { text, part = 1, parts = 1, baseCurrency, today, expense, income } = body;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw new Error("text");
  if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || parts < 1 || part > parts || parts > 40) throw new Error("part");
  if (typeof baseCurrency !== "string" || !/^[A-Z]{3}$/.test(baseCurrency)) throw new Error("baseCurrency");
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("today");
  // The person's own date, which can be a day either side of the server's.
  const drift = Math.abs(Date.parse(`${today}T12:00:00Z`) - Date.now());
  if (!(drift < 3 * 86_400_000)) throw new Error("today");
  return { text, part, parts, baseCurrency, today, expense: categories(expense), income: categories(income) };
}

/// Codes plus, for the person's own categories, a name so the AI knows what they mean.
function categories(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CATEGORIES) throw new Error("categories");
  return list.map((option) => {
    const code = option?.code;
    const name = option?.name;
    if (typeof code !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(code)) throw new Error("category code");
    if (name != null && (typeof name !== "string" || name.length > 40)) throw new Error("category name");
    const clean = name?.replace(/[\r\n()]/g, " ").trim();
    return clean ? `${code} (${clean})` : code;
  });
}

function systemPrompt({ baseCurrency, today, expense, income }) {
  return `You read bank, credit card and e-wallet statements and list every individual transaction as JSON.
Today is ${today}. The person's main currency is ${baseCurrency}.

Reply with one JSON object: {"transactions":[{"d":"YYYY-MM-DD","m":"merchant","a":12.34,"c":"SGD","k":"e","cat":"food","src":"raw line"}]}
- d: the transaction date (not the posting date if both are shown). If the year isn't printed, infer it from the statement period; otherwise use the most recent date that is not in the future.
- m: a short, clean merchant or payer name as a person would say it (e.g. "GRAB*FOOD 8823 SG" -> "Grab Food"). Keep the original language.
- a: the amount as a positive number, without currency symbols or thousands separators.
- c: ISO 4217 currency code of the amount. Use ${baseCurrency} if none is shown.
- k: "e" for money going out (purchases, bills, fees, interest charged), "i" for money coming in (salary, refunds, cashback, interest earned), "t" for moving money between the person's own accounts (credit card repayments made from a bank account, top-ups of their own wallet, transfers to their own savings).
- cat: for "e" one of: ${expense.join(", ")}. For "i" one of: ${income.join(", ")}. For "t" use "other". Give only the code; a code followed by a name in brackets is the person's own category, prefer it when it fits.
- src: the original line as printed, at most 60 characters.
Do not list opening or closing balances, totals, subtotals, minimum payments, credit limits, exchange rate notes or anything that is not a single transaction.
Never invent transactions. If there are none, reply {"transactions":[]}.`;
}

/// Adds the call's cost to the session, the person's day and their total; the first paid-for
/// chunk of a free statement import counts it against this device's month.
/// A single-use session already counted its one chunk when it was claimed.
async function record(env, current, cost, claimed = false) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET spent_micro = spent_micro + ?2, chunks = chunks + ?3 WHERE token = ?1").bind(current.token, cost, claimed ? 0 : 1),
    env.DB.prepare(
      `INSERT INTO usage_daily (user_id, day, cost_micro, chunks) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(user_id, day) DO UPDATE SET cost_micro = cost_micro + ?3, chunks = chunks + 1`
    ).bind(current.user_id, today(), cost),
    env.DB.prepare("UPDATE users SET cost_micro = cost_micro + ?2, chunks = chunks + 1, last_seen = ?3 WHERE id = ?1").bind(current.user_id, cost, now),
  ]);
  if (current.tier === "free" && current.device_token && current.device_count !== null) {
    const claimed = await env.DB.prepare("UPDATE sessions SET trial_marked = 1 WHERE token = ?1 AND trial_marked = 0 RETURNING token").bind(current.token).first();
    if (claimed) {
      try {
        await setFreeImportsThisMonth(env, current.device_token, current.sandbox === 1, current.device_count + 1);
      } catch (error) {
        console.log(JSON.stringify({ event: "trial_mark", ok: false, error: String(error.message || error) }));
      }
    }
  }
}
