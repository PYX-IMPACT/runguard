// Front door: Discord login, sessions, owner tools. Everything else goes to the original worker (runguard.js).
import runguard from "./runguard.js";

const DB_NAME_HIDDEN = ["sessions", "oauth_states", "login_attempts"]; // never shown in the raw DB viewer
const HOURS = { verifier: 12, owner: 2 };
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const rand = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const go = loc => new Response(null, { status: 302, headers: { location: loc } });

async function same(a, b) { // constant-time compare of hashes
  const x = await sha(a), y = await sha(b); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function wrap(res, env) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", env.SITE_URL ? new URL(env.SITE_URL).origin : "null");
  h.set("access-control-allow-headers", "authorization,content-type");
  h.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  h.set("access-control-max-age", "600");
  h.set("vary", "Origin");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "no-referrer");
  h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const res = await route(req, env, ctx).catch(e => { console.error(e); return json({ error: "Server error" }, 500); });
    return wrap(res, env);
  }
};

const audit = (env, actor, action, target, detail) =>
  env.DB.prepare("INSERT INTO audit_log(at,actor,action,target,detail) VALUES(?,?,?,?,?)")
    .bind(Date.now(), actor, action, target ?? null, detail ?? null).run();

async function newSession(env, role, discordId, name) {
  const token = rand(), now = Date.now();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now).run();
  await env.DB.prepare("INSERT INTO sessions(token_hash,role,discord_id,name,expires_at) VALUES(?,?,?,?,?)")
    .bind(await sha(token), role, discordId, name, now + HOURS[role] * 3600e3).run();
  return token;
}

async function getSession(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?").bind(await sha(t), Date.now()).first();
  if (!s) return null;
  if (s.role === "verifier") { // removal or blocking takes effect immediately
    const u = await env.DB.prepare("SELECT role FROM users WHERE discord_id=?").bind(s.discord_id).first();
    if (!u || u.role !== "verifier") return null;
  }
  s.token_hash = t; // keep raw token only in memory so logout can delete it
  return s;
}

async function route(req, env, ctx) {
  const url = new URL(req.url), p = url.pathname, m = req.method;
  if (m === "OPTIONS") return new Response(null, { status: 204 });

  const authPath = p.startsWith("/auth/") || p.startsWith("/owner/") || p === "/runs" || p === "/review" || p === "/me" || p === "/logout";
  if (!authPath) return runguard.fetch(req, env, ctx); // /submit etc. untouched
  for (const k of ["SITE_URL", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "OWNER_PASSWORD", "ADMIN_TOKEN"])
    if (!env[k]) return json({ error: "Server not configured: missing " + k }, 500);

  if (p === "/auth/discord/login") return discordLogin(env, url);
  if (p === "/auth/discord/callback") return discordCallback(env, url);
  if (p === "/owner/login" && m === "POST") return ownerLogin(req, env);

  const s = await getSession(req, env);
  if (!s) return json({ error: "Not logged in" }, 401);

  if (p === "/me") return json({ role: s.role, name: s.name });
  if (p === "/logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha(s.token_hash)).run();
    return json({ ok: true });
  }
  if (p.startsWith("/owner/")) {
    if (s.role !== "owner") return json({ error: "Forbidden" }, 403);
    return ownerApi(req, env, url, s);
  }
  if (p === "/runs" && m === "DELETE") { // only runs that have been reviewed can be deleted
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) return json({ error: "Bad run id" }, 400);
    const r = await env.DB.prepare("SELECT run_id,player_name,map_name,review_state FROM runs WHERE id=?").bind(id).first();
    if (!r) return json({ error: "Run not found" }, 404);
    if (r.review_state === "pending") return json({ error: "Review the run first (clear it or confirm cheat), then delete it." }, 403);
    await env.DB.prepare("DELETE FROM runs WHERE id=?").bind(id).run();
    await audit(env, (s.discord_id ? `${s.name} (${s.discord_id})` : s.name), "run:deleted", String(id),
      `${r.player_name} | ${r.map_name} | ${r.run_id} | was ${r.review_state}`.slice(0, 300));
    return json({ ok: true });
  }
  if (p === "/runs" || p === "/review") { // verifiers and owner: forward with the secret admin token added server-side
    const body = p === "/review" ? await req.clone().json().catch(() => ({})) : null;
    const h = new Headers(req.headers);
    h.set("authorization", "Bearer " + env.ADMIN_TOKEN);
    const res = await runguard.fetch(new Request(req, { headers: h }), env, ctx);
    if (body && res.ok)
      await audit(env, (s.discord_id ? `${s.name} (${s.discord_id})` : s.name), "review:" + body.state, String(body.id), String(body.note || "").slice(0, 300));
    return res;
  }
  return json({ error: "Not found" }, 404);
}

const redirectUri = url => new URL("/auth/discord/callback", url.origin).href;

async function discordLogin(env, url) {
  const state = rand(), now = Date.now();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now).run();
  await env.DB.prepare("INSERT INTO oauth_states(state,expires_at) VALUES(?,?)").bind(state, now + 600e3).run();
  const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", scope: "identify", state, redirect_uri: redirectUri(url) });
  return go("https://discord.com/oauth2/authorize?" + q);
}

async function discordCallback(env, url) {
  const back = e => go(`${env.SITE_URL}/?e=${e}`);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back("denied");
  if (!code || !/^[a-f0-9]{64}$/.test(state || "")) return back("failed");
  const st = await env.DB.prepare("SELECT expires_at FROM oauth_states WHERE state=?").bind(state).first();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run(); // one use only
  if (!st || st.expires_at < Date.now()) return back("failed");

  const tr = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri(url) })
  });
  if (!tr.ok) return back("failed");
  const { access_token } = await tr.json();
  const ur = await fetch("https://discord.com/api/users/@me", { headers: { authorization: "Bearer " + access_token } });
  const u = await ur.json().catch(() => ({}));
  if (!ur.ok || !/^\d{5,25}$/.test(u.id || "")) return back("failed");

  const now = Date.now(), name = u.global_name || u.username || "Discord user";
  const ex = await env.DB.prepare("SELECT role FROM users WHERE discord_id=?").bind(u.id).first();
  if (!ex) { // unknown accounts become approval requests (capped so nobody can flood the table)
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='pending'").first();
    if (c.n >= 200) return back("failed");
    await env.DB.prepare("INSERT INTO users(discord_id,username,global_name,role,created_at,last_login) VALUES(?,?,?,'pending',?,?)")
      .bind(u.id, u.username || null, u.global_name || null, now, now).run();
  } else {
    await env.DB.prepare("UPDATE users SET username=?,global_name=?,last_login=? WHERE discord_id=?")
      .bind(u.username || null, u.global_name || null, now, u.id).run();
  }
  const role = ex ? ex.role : "pending";
  if (role !== "verifier") return back(role === "blocked" ? "blocked" : "pending");
  const token = await newSession(env, "verifier", u.id, name);
  await audit(env, `${name} (${u.id})`, "login");
  return go(`${env.SITE_URL}/#rg=${token}`);
}

async function ownerLogin(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown", since = Date.now() - 15 * 60e3;
  await env.DB.prepare("DELETE FROM login_attempts WHERE at<?").bind(since).run();
  const c = await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE ip=? AND at>=?").bind(ip, since).first();
  if (c.n >= 5) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  const b = await req.json().catch(() => ({}));
  if (typeof b.password !== "string" || !(await same(b.password, env.OWNER_PASSWORD))) {
    await env.DB.prepare("INSERT INTO login_attempts(ip,at) VALUES(?,?)").bind(ip, Date.now()).run();
    await audit(env, "unknown", "owner login FAILED", ip);
    return json({ error: "Wrong password." }, 401);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip=?").bind(ip).run();
  await audit(env, "owner", "owner login", ip);
  return json({ token: await newSession(env, "owner", null, "Owner") });
}

async function ownerApi(req, env, url, s) {
  const p = url.pathname, m = req.method;

  if (p === "/owner/users") {
    if (m === "GET") {
      const r = await env.DB.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'pending' THEN 0 WHEN 'verifier' THEN 1 ELSE 2 END, created_at DESC LIMIT 500").all();
      return json(r.results);
    }
    if (m === "POST") {
      const b = await req.json().catch(() => ({}));
      const id = String(b.discord_id || "").trim();
      if (!/^\d{15,25}$/.test(id)) return json({ error: "That is not a valid Discord user ID (17-19 digits)." }, 400);
      if (!["verifier", "blocked", "pending"].includes(b.role)) return json({ error: "Bad role" }, 400);
      const label = String(b.label || "").trim().slice(0, 60) || null;
      await env.DB.prepare(`INSERT INTO users(discord_id,username,role,added_by,created_at) VALUES(?,?,?,'owner',?)
        ON CONFLICT(discord_id) DO UPDATE SET role=excluded.role, added_by='owner', username=COALESCE(users.username,excluded.username)`)
        .bind(id, label, b.role, Date.now()).run();
      if (b.role !== "verifier") await env.DB.prepare("DELETE FROM sessions WHERE discord_id=?").bind(id).run();
      await audit(env, "owner", "user:" + b.role, id, label);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      const id = url.searchParams.get("id") || "";
      await env.DB.prepare("DELETE FROM users WHERE discord_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM sessions WHERE discord_id=?").bind(id).run();
      await audit(env, "owner", "user:removed", id);
      return json({ ok: true });
    }
  }

  if (p === "/owner/audit" && m === "GET") {
    const r = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all();
    return json(r.results);
  }

  if (p === "/owner/db" && m === "GET") { // read-only raw viewer
    const all = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all())
      .results.map(x => x.name).filter(n => !DB_NAME_HIDDEN.includes(n));
    const tables = [];
    for (const name of all) tables.push({ name, count: (await env.DB.prepare(`SELECT COUNT(*) n FROM "${name}"`).first()).n });
    const table = all.includes(url.searchParams.get("table")) ? url.searchParams.get("table") : all[0]; // name checked against real table list
    if (!table) return json({ tables, table: null, rows: [], total: 0, offset: 0 });
    const offset = Math.max(0, parseInt(url.searchParams.get("offset")) || 0);
    const rows = (await env.DB.prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT 50 OFFSET ?`).bind(offset).all()).results
      .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && v.length > 1500 ? v.slice(0, 1500) + "…" : v])));
    return json({ tables, table, rows, total: tables.find(t => t.name === table).count, offset });
  }
  return json({ error: "Not found" }, 404);
}
