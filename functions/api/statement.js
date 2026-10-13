// POST /api/statement: reads one chunk of a bank statement with DeepSeek for the Lavie app.
//
// The DeepSeek key lives only here (the DEEPSEEK_API_KEY secret). The app sends the
// statement text and the person's categories; the prompt, model and output limit are
// fixed below, so this can't be used as a general-purpose DeepSeek endpoint.
// Requests are counted in D1 per (hashed) IP per hour and per day, plus a daily cap
// for everyone together, which bounds the bill whatever happens.

const MODEL = "deepseek-flash";
const MAX_TEXT = 12_000; // UTF-16 units; the app sends chunks of 9,000 characters.
const MAX_CATEGORIES = 80;

export async function onRequestPost({ request, env }) {
  if (!env.DEEPSEEK_API_KEY || !env.DB) return reply(503, { error: "unavailable" });

  let input;
  try {
    input = validate(await request.json());
  } catch (error) {
    return reply(400, { error: "bad_request", detail: String(error.message || error) });
  }

  const limited = await overLimit(request, env);
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
          { role: "system", content: systemPrompt(input) },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    return reply(502, { error: "upstream" });
  }
  if (!response.ok) return reply(502, { error: "upstream", status: response.status });

  const envelope = await response.json().catch(() => null);
  const content = envelope?.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return reply(502, { error: "unreadable" });
  }
  if (!Array.isArray(parsed?.transactions)) return reply(502, { error: "unreadable" });
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

/// Counts this request and says which limit it went over, if any.
async function overLimit(request, env) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // Only a hash of the address, salted per day, is kept; counts older than two days are removed.
  const who = await hash(`${env.IP_SALT || "lavie"}|${day}|${ip}`);
  const statement = env.DB.prepare(
    "INSERT INTO usage (bucket, day, count) VALUES (?1, ?2, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count"
  );
  const count = (result) => result.results?.[0]?.count ?? 0;
  const expired = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const [perHour, perDay] = await env.DB.batch([
    statement.bind(`ip:${who}:${hour}`, day),
    statement.bind(`ip:${who}:${day}`, day),
    env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(expired),
  ]);
  if (count(perHour) > Number(env.LIMIT_IP_HOUR || 40)) return "hour";
  if (count(perDay) > Number(env.LIMIT_IP_DAY || 150)) return "day";
  // Only requests that pass their own limits count toward everyone's.
  const all = await statement.bind(`all:${day}`, day).run();
  return count(all) > Number(env.LIMIT_ALL_DAY || 4000) ? "all" : null;
}

async function hash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
