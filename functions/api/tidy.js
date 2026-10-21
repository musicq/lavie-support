// POST /api/tidy: suggests clean names and better categories for the names a person has recorded
// in Lavie (Settings › Categories › Tidy with AI).
//
// The app sends only names, how many entries each has, and the categories (no amounts, no dates),
// with a session token from /api/session (purpose "tidy"). The prompt, model and output limit are
// fixed here, and the reply is checked against what was sent: every id, code and icon in it is one
// the app gave. The app shows each suggestion for review before anything changes.

import { claimSingleUse, costMicro, overLimit, purposeOf, reply, session, today } from "../../lib/proxy.js";

const MODEL = "deepseek-flash";
const MAX_NAMES = 300; // per kind; the app sends the busiest
const MAX_CATEGORIES = 80;
const MAX_NEW = 3;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DEEPSEEK_API_KEY || !env.DB) return reply(503, { error: "unavailable" });

  const current = await session(request, env);
  if (!current) return reply(401, { error: "session" });
  if (purposeOf(current) !== "tidy") return reply(401, { error: "session" });
  if (current.spent_micro >= current.budget_micro) return reply(429, { error: "daily_limit" });

  let input;
  try {
    input = validate(await request.json());
  } catch (error) {
    return reply(400, { error: "bad_request", detail: String(error.message || error) });
  }

  const limited = await overLimit(request, env, "tidy", 10, 30);
  if (limited) return reply(429, { error: "busy", scope: limited });
  // One tidy per session.
  if (!(await claimSingleUse(env, current))) return reply(401, { error: "session" });

  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: "disabled" },
        temperature: 0,
        // 600 names at ~25 tokens each, plus a few new categories.
        max_tokens: 16_000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(input) },
          { role: "user", content: userPrompt(input) },
        ],
      }),
    });
  } catch {
    return reply(502, { error: "upstream" });
  }
  if (!response.ok) return reply(502, { error: "upstream", status: response.status });

  const envelope = await response.json().catch(() => null);
  waitUntil(record(env, current, costMicro(envelope?.usage)));
  let parsed;
  try {
    parsed = JSON.parse(envelope?.choices?.[0]?.message?.content);
  } catch {
    return reply(502, { error: "unreadable" });
  }
  if (!parsed || typeof parsed !== "object") return reply(502, { error: "unreadable" });
  return reply(200, sanitize(parsed, input));
}

// MARK: Input

function validate(body) {
  if (typeof body !== "object" || body === null) throw new Error("body");
  const { language, allowNew, icons, expense, income } = body;
  if (typeof language !== "string" || !/^[A-Za-z-]{2,12}$/.test(language)) throw new Error("language");
  if (!Array.isArray(icons) || icons.length > 120 || !icons.every((icon) => typeof icon === "string" && /^[a-z0-9.]{1,48}$/.test(icon))) {
    throw new Error("icons");
  }
  const kinds = { e: side(expense, "e"), i: side(income, "i") };
  if (kinds.e.names.length + kinds.i.names.length === 0) throw new Error("names");
  return { language, allowNew: allowNew === true, icons, kinds };
}

function side(value, prefix) {
  if (typeof value !== "object" || value === null) throw new Error("kind");
  const { categories, names } = value;
  if (!Array.isArray(categories) || categories.length === 0 || categories.length > MAX_CATEGORIES) throw new Error("categories");
  if (!Array.isArray(names) || names.length > MAX_NAMES) throw new Error("names");
  const cats = categories.map((category) => {
    if (typeof category?.code !== "string" || !CODE.test(category.code)) throw new Error("category code");
    return { code: category.code, name: text(category.name, 40, "category name"), count: count(category.n) };
  });
  const codes = new Set(cats.map((category) => category.code));
  const seen = new Set();
  const list = names.map((name) => {
    const id = name?.id;
    if (typeof id !== "string" || !new RegExp(`^${prefix}[0-9]{1,4}$`).test(id) || seen.has(id)) throw new Error("name id");
    seen.add(id);
    if (!codes.has(name.cat)) throw new Error("name category");
    return { id, name: text(name.name, 60, "name"), cat: name.cat, count: count(name.n) };
  });
  return { categories: cats, codes, names: list };
}

function text(value, max, what) {
  if (typeof value !== "string") throw new Error(what);
  const clean = value.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > max) throw new Error(what);
  return clean;
}

const count = (value) => (Number.isInteger(value) && value > 0 && value < 1_000_000 ? value : 1);

// MARK: Prompt

function systemPrompt({ language, allowNew, icons }) {
  const fresh = allowNew
    ? `- "new": a new category, only when at least 3 names clearly belong together and the existing categories don't describe them well: they sit in "other", or in a category far broader than they are (several subscriptions spread across "other" and "entertainment" can become "Subscriptions"). At most ${MAX_NEW} in all. "k" is "e" for spending, "i" for income. Name it in the app's language (${language}), one or two words. "icon" is one of: ${icons.join(", ")}. Give names in it its "ref" as their "cat".`
    : `- "new": always []. This person can't add categories.`;
  return `You tidy the names in a person's money diary (the Lavie app). A name is a shop, a service, a person or a thing they paid or were paid; every entry with the same name shares one category.

Reply with one JSON object: {"new":[{"ref":"n1","k":"e","name":"Subscriptions","icon":"tv.fill"}],"names":[{"id":"e3","name":"Grab","cat":"transportation"}]}
- "names": only the names you change, by id.
  - "name": the name as a person would say it. Drop card numbers, reference codes, cities and countries, "PTE LTD", "INC", and payment processor prefixes ("GRAB* A-8XK2J SINGAPORE" -> "Grab", "SPOTIFY P1A2B3C4" -> "Spotify", "Google *YouTube Premium" -> "YouTube Premium", "NETFLIX.COM" -> "Netflix"). Give spellings of the same merchant one spelling so they merge; when one of them is already clean, use it ("NTUC FAIRPRICE #123" and "FairPrice" -> both "FairPrice"). Keep the language and script it is written in; never translate. Leave a name that is already clean exactly as it is. Never merge different merchants, and never replace a name with its category ("Lunch" stays "Lunch").
  - "cat": the code of the category it belongs in. Keep the current one unless another one clearly fits better; move names out of "other" when one fits, and never move a name into "other". A name stays in its kind (spending or income).
${fresh}
Never rename, remove or merge the existing categories. If nothing needs changing, reply {"new":[],"names":[]}.`;
}

function userPrompt({ kinds }) {
  const block = (title, side) => {
    const cats = side.categories.map((category) => `${category.code}: ${category.name} (${category.count})`).join("\n");
    const names = side.names.map((name) => `${name.id} | ${name.name} | ${name.cat} | ${name.count}`).join("\n");
    return `${title} categories (code: name (entries)):\n${cats}\n\n${title} names (id | name | category | entries):\n${names || "(none)"}`;
  };
  return `${block("Spending", kinds.e)}\n\n${block("Income", kinds.i)}`;
}

// MARK: Reply

/// Keeps only what refers to what was sent: known ids, codes of the name's own kind, listed icons.
function sanitize(parsed, { allowNew, icons, kinds }) {
  const iconSet = new Set(icons);
  const fresh = [];
  const refs = { e: new Set(), i: new Set() };
  if (allowNew && Array.isArray(parsed.new)) {
    for (const item of parsed.new) {
      if (fresh.length >= MAX_NEW) break;
      const kind = item?.k === "i" ? "i" : item?.k === "e" ? "e" : null;
      const ref = typeof item?.ref === "string" && /^n[0-9]{1,2}$/.test(item.ref) ? item.ref : null;
      const name = typeof item?.name === "string" ? item.name.replace(/\s+/g, " ").trim().slice(0, 30) : "";
      if (!kind || !ref || !name || refs.e.has(ref) || refs.i.has(ref)) continue;
      refs[kind].add(ref);
      fresh.push({ ref, k: kind, name, icon: iconSet.has(item.icon) ? item.icon : "tag.fill" });
    }
  }
  const byID = new Map([...kinds.e.names, ...kinds.i.names].map((name) => [name.id, name]));
  const names = [];
  const used = new Set();
  const seen = new Set();
  for (const item of Array.isArray(parsed.names) ? parsed.names : []) {
    const original = byID.get(item?.id);
    if (!original || seen.has(original.id)) continue;
    const kind = original.id[0];
    const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    // Known codes of the name's own kind only, and never into "other": that's where tidying starts, not ends.
    const known = kinds[kind].codes.has(item.cat) || refs[kind].has(item.cat);
    const cat = known && item.cat !== "other" ? item.cat : original.cat;
    const renamed = name && name !== original.name ? name : null;
    if (!renamed && cat === original.cat) continue;
    seen.add(original.id);
    if (refs[kind].has(cat)) used.add(cat);
    names.push({ id: original.id, name: renamed ?? original.name, cat });
  }
  return { new: fresh.filter((item) => used.has(item.ref)), names };
}

/// Adds the call's cost to the session, the person's day and their total.
async function record(env, current, cost) {
  const now = new Date().toISOString();
  await env.DB.batch([
    // Its one chunk was counted when the session was claimed.
    env.DB.prepare("UPDATE sessions SET spent_micro = spent_micro + ?2 WHERE token = ?1").bind(current.token, cost),
    env.DB.prepare(
      `INSERT INTO usage_daily (user_id, day, cost_micro, chunks) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(user_id, day) DO UPDATE SET cost_micro = cost_micro + ?3, chunks = chunks + 1`
    ).bind(current.user_id, today(), cost),
    env.DB.prepare("UPDATE users SET cost_micro = cost_micro + ?2, chunks = chunks + 1, last_seen = ?3 WHERE id = ?1").bind(current.user_id, cost, now),
  ]);
}
