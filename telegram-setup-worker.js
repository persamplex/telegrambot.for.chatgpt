// Deploy this file as a Cloudflare Worker (ES module). The installer has no bindings.
const CF_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{25,100}$/;
const CHAT_ID = /^-?[1-9]\d{0,15}$/;
const KEY = /^[a-f0-9]{64}$/;
const WORKER_NAME = /^telegram-gateway-[a-f0-9]{16}$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BOT_API = "https://api.telegram.org/bot";
const NO_STORE = { "Cache-Control": "no-store" };
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);

const tokenLink = new URL("https://dash.cloudflare.com/profile/api-tokens");
tokenLink.search = new URLSearchParams({
  permissionGroupKeys: JSON.stringify([
    { key: "workers_scripts", type: "edit" },
    { key: "account_settings", type: "read" },
  ]),
  accountId: "*",
  zoneId: "all",
  name: "Telegram Gateway Setup",
});

class SetupError extends Error {
  constructor(code, status = 400, fields = {}) {
    super(code);
    this.status = status;
    this.fields = { code, ...fields };
  }
}

// Shared by the installer and the generated gateway.
async function readJson(request, limit = 32768) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw Object.assign(new Error("unsupported_media_type"), { status: 415 });
  }
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("invalid_json"), { status: 400 });
  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("body_too_large"), { status: 413 });
    }
    raw += decoder.decode(value, { stream: true });
  }
  try {
    const value = JSON.parse(raw + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function telegram(token, method, payload = {}) {
  const response = await fetch(BOT_API + token + "/" + method, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(7000),
    body: new URLSearchParams(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) {
    throw Object.assign(new Error("telegram_api"), {
      status: response.status,
      providerCode: Number.isInteger(data?.error_code) ? data.error_code : undefined,
    });
  }
  return data.result;
}

// This function is serialized as the generated Worker's module.
async function gatewayFetch(request, env) {
  const { pathname } = new URL(request.url);
  const registration = pathname === "/registerWebhook";
  const origin = request.headers.get("Origin");
  const cors = registration && origin === env.INSTALLER_ORIGIN
    ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {};
  const headers = { "Cache-Control": "no-store", ...cors };
  const reply = (body, status = 200) => Response.json(body, { status, headers });
  const fail = (error, status, extra = {}) => reply({ ok: false, error, ...extra }, status);

  if (pathname === "/" && request.method === "GET") {
    return new Response("Telegram gateway is online.", { headers: {
      "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    } });
  }
  if (registration && request.method === "OPTIONS" && origin && origin === env.INSTALLER_ORIGIN) {
    return new Response(null, { status: 204, headers: {
      ...headers,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    } });
  }
  if (!registration && pathname !== "/send" && pathname !== "/webhook") return fail("not_found", 404);
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const expected = pathname === "/webhook" ? env.WEBHOOK_SECRET : "Bearer " + env.API_KEY;
  const actual = request.headers.get(pathname === "/webhook"
    ? "X-Telegram-Bot-Api-Secret-Token" : "Authorization");
  if (!env.API_KEY || !env.WEBHOOK_SECRET || actual !== expected) return fail("unauthorized", 401);

  let body;
  try {
    body = await readJson(request, pathname === "/webhook" ? 262144 : 32768);
  } catch (error) {
    return fail(error.message, error.status ?? 400);
  }

  try {
    if (registration) {
      const url = env.WORKER_URL + "/webhook";
      const current = await telegram(env.TELEGRAM_BOT_TOKEN, "getWebhookInfo");
      if (current.url && current.url !== url && body.replaceExisting !== true) {
        return fail("webhook_conflict", 409);
      }
      await telegram(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
        url,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: '["message"]',
      });
      const checked = await telegram(env.TELEGRAM_BOT_TOKEN, "getWebhookInfo");
      return checked.url === url ? reply({ ok: true, url }) : fail("webhook_unverified", 502);
    }

    let message = body.text;
    if (pathname === "/webhook") {
      const update = body.message;
      if (String(update?.chat?.id) !== env.ADMIN_CHAT_ID ||
          typeof update?.text !== "string" ||
          !/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(update.text)) return reply({ ok: true });
      message = "وب‌هوک فعاله ✅";
    } else if (typeof message !== "string" || !message.trim() || message.length > 4096 ||
               Object.keys(body).some(key => key !== "text")) {
      return fail("invalid_text", 400);
    }
    await telegram(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_CHAT_ID, text: message });
    return reply({ ok: true });
  } catch (error) {
    return fail("telegram_unavailable", 502, {
      ...(error.providerCode ? { telegramCode: error.providerCode } : {}),
    });
  }
}

const gatewayCode = "const BOT_API = " + JSON.stringify(BOT_API) + ";\n" +
  [readJson, telegram, gatewayFetch].map(fn => fn.toString()).join("\n\n") +
  "\nexport default { fetch: gatewayFetch };\n";

async function cloudflare(token, path, stage, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer " + token);
  let response;
  try {
    response = await fetch(CF_API + path, {
      ...options, headers, redirect: "manual", signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new SetupError("cloudflare_network", 502, { stage });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    const provider = Array.isArray(data?.errors) ? data.errors : [];
    const error = new SetupError("cloudflare_error", response.status === 401 || response.status === 403
      ? 403 : response.status === 429 ? 429 : 502, {
      stage,
      upstreamStatus: response.status,
      cloudflareCodes: provider.map(item => item.code).filter(Number.isInteger),
    });
    error.missingSubdomain = response.status === 404 || error.fields.cloudflareCodes.includes(10007) ||
      provider.some(item => typeof item.message === "string" &&
        /subdomain.*(?:not found|does not exist|not (?:been )?register|not configured)|(?:no|register a) .*subdomain/i.test(item.message));
    throw error;
  }
  return data;
}

const jsonOptions = (method, body) => ({
  method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

async function accountSubdomain(token, account, name) {
  const path = "/accounts/" + account + "/workers/subdomain";
  async function get() {
    try {
      const result = (await cloudflare(token, path, "subdomain")).result?.subdomain;
      return SUBDOMAIN.test(result ?? "") ? result : null;
    } catch (error) {
      if (error.missingSubdomain) return null;
      throw error;
    }
  }
  const existing = await get();
  if (existing) return existing;
  try {
    const desired = "tg-" + name.slice(-16);
    const created = (await cloudflare(token, path, "create_subdomain",
      jsonOptions("PUT", { subdomain: desired }))).result?.subdomain;
    if (SUBDOMAIN.test(created ?? "")) return created;
  } catch (error) {
    const concurrent = await get().catch(() => null);
    if (concurrent) return concurrent;
    throw new SetupError("subdomain_setup", error.status, error.fields ? {
      upstreamStatus: error.fields.upstreamStatus, cloudflareCodes: error.fields.cloudflareCodes,
      stage: "create_subdomain",
    } : { stage: "create_subdomain" });
  }
  const verified = await get();
  if (!verified) throw new SetupError("subdomain_setup", 502, { stage: "create_subdomain" });
  return verified;
}

async function deploy(input, origin) {
  const { cfToken, accountId, chatId, botToken, name, apiKey, webhookSecret } = input;
  if (!matches(cfToken, TOKEN) || !matches(accountId, ACCOUNT_ID) ||
      !matches(chatId, CHAT_ID) || !matches(botToken, BOT_TOKEN) ||
      !matches(name, WORKER_NAME) || !matches(apiKey, KEY) || !matches(webhookSecret, KEY)) {
    throw new SetupError("invalid_deploy_input");
  }
  let bot;
  try {
    bot = await telegram(botToken, "getMe");
  } catch (error) {
    throw new SetupError(error.status === 401 || error.status === 404 ? "bot_token_invalid" :
      "telegram_preflight", 502, { stage: "bot", telegramCode: error.providerCode });
  }
  const subdomain = await accountSubdomain(cfToken, accountId, name);
  const workerUrl = "https://" + name + "." + subdomain + ".workers.dev";
  const workerPath = "/accounts/" + accountId + "/workers/scripts/" + name;
  const form = new FormData();
  const bindings = [
    { name: "ADMIN_CHAT_ID", type: "plain_text", text: chatId },
    { name: "WORKER_URL", type: "plain_text", text: workerUrl },
    { name: "INSTALLER_ORIGIN", type: "plain_text", text: origin },
    ...Object.entries({ TELEGRAM_BOT_TOKEN: botToken, API_KEY: apiKey, WEBHOOK_SECRET: webhookSecret })
      .map(([name, text]) => ({ name, type: "secret_text", text })),
  ];
  form.set("metadata", new Blob([JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-04-01",
    bindings,
  })], { type: "application/json" }));
  form.set("worker.js", new Blob([gatewayCode], { type: "application/javascript+module" }), "worker.js");
  await cloudflare(cfToken, workerPath, "upload", { method: "PUT", body: form });
  await cloudflare(cfToken, workerPath + "/subdomain", "publish",
    jsonOptions("POST", { enabled: true, previews_enabled: false }));
  return { workerUrl, name, botUsername: typeof bot?.username === "string" ? bot.username : null };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = crypto.randomUUID().replaceAll("-", "");
      return new Response(page(nonce), { headers: {
        ...NO_STORE,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; " +
          "style-src 'nonce-" + nonce + "' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
          "script-src 'nonce-" + nonce + "'; connect-src 'self' https://*.workers.dev",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    if (!["/api/accounts", "/api/deploy"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (request.headers.get("Origin") !== url.origin) return new Response(null, { status: 403 });
    try {
      const input = await readJson(request, 8192);
      if (url.pathname === "/api/accounts") {
        if (!matches(input.cfToken, TOKEN)) throw new SetupError("invalid_cf_token");
        const accounts = [];
        for (let page = 1; page <= 10; page++) {
          const data = await cloudflare(input.cfToken, "/accounts?per_page=50&page=" + page, "accounts");
          const batch = Array.isArray(data.result) ? data.result : [];
          accounts.push(...batch.filter(item => ACCOUNT_ID.test(item.id))
            .map(({ id, name }) => ({ id, name: String(name ?? "") })));
          if (batch.length < 50 || (data.result_info?.total_pages && page >= data.result_info.total_pages)) break;
        }
        return Response.json({ ok: true, accounts }, { headers: NO_STORE });
      }
      return Response.json({ ok: true, ...await deploy(input, url.origin) }, { headers: NO_STORE });
    } catch (error) {
      const status = error instanceof SetupError ? error.status : error.status || 500;
      const fields = error instanceof SetupError ? error.fields : { code: status === 500 ? "unexpected" : error.message };
      return Response.json({ ok: false, ...fields }, { status, headers: NO_STORE });
    }
  },
};

function page(nonce) {
  const escapedLink = tokenLink.href.replaceAll("&", "&amp;");
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#151313"><title>راه‌انداز تلگرام</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap">
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#151313;--panel:#211e1e;--field:#191616;--paper:#faf2e6;--muted:#b9adab;--line:#403636;--accent:#f5a278;--violet:#c7b2ff;--green:#acddb1;--radius:22px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--paper);font:400 15px/1.85 Vazirmatn,Tahoma,sans-serif}
button,input,select,textarea{font:inherit}button,a,input,select,textarea{-webkit-tap-highlight-color:transparent}
a{color:var(--violet);text-underline-offset:4px}a:hover{color:var(--paper)}:focus-visible{outline:2px solid var(--violet);outline-offset:4px}
[hidden]{display:none!important}.wrap{width:min(1120px,calc(100% - 56px));margin:auto}
header{height:78px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:19px}.mark{width:35px;height:35px;border-radius:11px;display:grid;place-items:center;color:#221518;background:var(--accent);font-size:23px;line-height:1}
header a{font-size:13px;color:var(--muted);text-decoration:none}.hero{position:relative;overflow:hidden;padding:46px 0 32px}
.hero h1{font-size:clamp(32px,5.3vw,62px);font-weight:800;letter-spacing:-.065em;line-height:1.2;margin:0 0 15px}.hero h1 span{color:var(--accent)}.hero p{margin:0;color:var(--muted);font-size:clamp(14px,2vw,17px)}
.layout{display:grid;grid-template-columns:minmax(0,1.52fr) minmax(280px,1fr);gap:20px;align-items:start;padding-bottom:38px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}.flow{padding:24px 28px 28px}
.progress{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;padding:0;margin:0 0 23px;list-style:none}
.progress li{min-width:0;color:var(--muted);font-size:12px;border-top:3px solid var(--line);padding:8px 2px 0;transition:color .24s,border-color .24s;white-space:nowrap}
.progress li[aria-current="step"]{color:var(--accent);border-color:var(--accent);font-weight:700}.progress li.done{border-color:var(--green);color:var(--green)}
.step:not([hidden]){animation:enter .32s cubic-bezier(.2,.7,.25,1) both}@keyframes enter{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}
h2{font-size:clamp(22px,3vw,29px);margin:0 0 5px;line-height:1.42;letter-spacing:-.035em}p{margin:0 0 15px}.muted{color:var(--muted)}.small{font-size:13px}
.field{margin:14px 0}label{display:block;font-weight:700;margin-bottom:6px}.input{display:flex;align-items:stretch;gap:8px}
input:not([type=checkbox]),select,textarea{border:1px solid var(--line);background:var(--field);color:var(--paper);border-radius:11px;min-width:0;width:100%;padding:10px 12px;outline-offset:2px}
input[type=password],input[dir=ltr],textarea,code,.ltr{font-family:ui-monospace,Consolas,monospace}.ltr{direction:ltr;unicode-bidi:isolate}
input::placeholder{color:#a39391}select{height:47px}.toggle{min-width:64px;color:var(--muted);background:var(--field);border:1px solid var(--line);border-radius:11px;cursor:pointer;font-size:12px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:17px}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:43px;padding:8px 15px;border-radius:10px;border:1px solid transparent;font-weight:750;line-height:1.4;text-decoration:none;cursor:pointer;transition:background .2s,transform .2s,color .2s}
.button:not(:disabled):hover{transform:translateY(-2px)}.button:active{transform:translateY(0)}.solid{background:var(--accent);color:#211410}.solid:hover{background:#ffb999;color:#211410}.ghost{border-color:var(--line);background:transparent;color:var(--paper)}.ghost:hover{background:#372d2d}
button:disabled{opacity:.55;cursor:wait}.guide{padding:11px 13px;border:1px solid var(--line);border-radius:11px;background:#272121;margin:13px 0;color:var(--muted);font-size:13px}
details summary{cursor:pointer;color:var(--violet)}details[open] summary{margin-bottom:8px}.notice{color:#ffd9c9;background:#472922;border:1px solid #76483b;border-radius:11px;padding:10px 13px;margin-top:15px;white-space:pre-line;overflow-wrap:anywhere}
.radial{min-height:342px;position:relative;background:#27212e;overflow:hidden;border:1px solid #493e50;border-radius:var(--radius);isolation:isolate;padding:26px}
.radial:before{content:"";position:absolute;inset:0;z-index:-2;background:radial-gradient(ellipse at 75% 17%,#765b92 0%,#493351 28%,#27212e 64%);opacity:.85}
.radial:after{content:"";position:absolute;inset:0;z-index:-1;background:repeating-linear-gradient(90deg,transparent 0 27px,#d8bbff10 28px,#d8bbff10 29px),repeating-linear-gradient(0deg,transparent 0 27px,#d8bbff10 28px,#d8bbff10 29px);mask-image:linear-gradient(#000,transparent 87%)}
.diagram{height:180px;position:relative;display:grid;place-items:center;isolation:isolate}.orbit{position:absolute;width:154px;aspect-ratio:1;border-radius:50%;border:1px solid #e3cbff6b;animation:orbit 13s linear infinite}
.orbit:before,.orbit:after{content:"";width:9px;height:9px;background:#e7ceff;box-shadow:0 0 17px #e7ceff;position:absolute;border-radius:100%;left:18px;top:18px}.orbit:after{left:auto;top:auto;right:17px;bottom:17px;width:6px;height:6px;background:var(--accent)}
.orbit.outer{width:196px;border-style:dashed;opacity:.5;animation-direction:reverse;animation-duration:22s}@keyframes orbit{to{transform:rotate(360deg)}}
.core{width:103px;aspect-ratio:1;border-radius:31px;display:grid;place-items:center;background:#e7d1ff;color:#312039;box-shadow:0 15px 55px #100a1b85;font-size:53px;line-height:1;animation:float 4s ease-in-out infinite}@keyframes float{50%{transform:translateY(-6px)}}
.radial h2{margin:8px 0 6px;font-size:23px}.radial p{color:#e0d0e7;margin:0;font-size:14px}
.check{display:flex;gap:8px;align-items:flex-start;color:var(--muted);font-size:13px;font-weight:500}.check input{accent-color:var(--accent);margin-top:7px}
.status{padding:12px 13px;border-radius:11px;border:1px solid var(--line);margin-top:15px;overflow-wrap:anywhere}.status.ok{color:var(--green);border-color:#536651}.status.busy:before{content:"";display:inline-block;width:10px;height:10px;border:2px solid #f5a27855;border-top-color:var(--accent);border-radius:50%;margin-left:8px;animation:orbit .7s linear infinite}
.output{margin-top:16px;border-top:1px solid var(--line);padding-top:14px}.output textarea{resize:vertical;min-height:160px;font-size:12px}.output input{font-size:12px}.ready{color:var(--green)}
.toast{position:fixed;z-index:5;inset-inline-start:50%;bottom:max(18px,env(safe-area-inset-bottom));translate:50% 8px;max-width:calc(100% - 32px);width:max-content;padding:9px 15px;border:1px solid #536651;border-radius:12px;background:#292a24;color:var(--paper);box-shadow:0 8px 32px #0006;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s,translate .2s}
.toast.visible{opacity:1;translate:50% 0}
footer{border-top:1px solid var(--line);padding:16px 0 24px;color:var(--muted);font-size:12px}
@media(max-width:770px){.wrap{width:calc(100% - 32px)}header{height:62px}.hero{padding:30px 0 22px}.layout{grid-template-columns:1fr;gap:14px}.flow{padding:17px}.radial{min-height:0;padding:13px 16px 19px}.diagram{height:133px;transform:scale(.72);margin:-3px 0}.radial h2{font-size:19px}.progress{gap:5px;margin-bottom:18px}.progress li{font-size:11px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style></head>
<body><div class="wrap">
<header><div class="brand"><span class="mark" aria-hidden="true">↗</span> راه‌انداز تلگرام</div><a href="https://developers.cloudflare.com/workers/" target="_blank" rel="noopener noreferrer">راهنمای Cloudflare ↗</a></header>
<main>
<div class="hero"><h1>ربات تلگرامت را <span>فعال کن.</span></h1><p>درگاه اختصاصی ارسال پیام از ChatGPT به تلگرام، روی حساب Cloudflare خودت.</p></div>
<div class="layout">
<section class="card flow" aria-label="مراحل راه‌اندازی">
<ol class="progress" id="progress"><li aria-current="step">حساب Cloudflare</li><li>شناسهٔ چت</li><li>توکن ربات</li><li>فعال‌سازی</li></ol>
<form class="step" id="cloudForm" autocomplete="off">
<h2>حساب Cloudflare را وصل کن</h2><p class="muted small">دکمهٔ ساخت توکن، فرم آمادهٔ Cloudflare را باز می‌کند. حساب مقصد را انتخاب کن، ساخت را تأیید کن و توکن را اینجا وارد کن.</p>
<a class="button ghost" href="${escapedLink}" target="_blank" rel="noopener noreferrer">ساخت توکن Cloudflare ↗</a>
<div class="field"><label for="cfToken">توکن API کلودفلر</label><div class="input"><input id="cfToken" type="password" dir="ltr" required maxlength="200" spellcheck="false" autocomplete="off" placeholder="Cloudflare API token"><button class="toggle" type="button" data-toggle="cfToken" aria-pressed="false">نمایش</button></div></div>
<div class="field" id="accountField" hidden><label for="account">حساب مقصد</label><select id="account"></select></div>
<details class="guide" id="manualPanel"><summary>وارد کردن Account ID به‌صورت دستی</summary><p>اگر حساب پیدا نشد، شناسهٔ ۳۲ کاراکتری را از داشبورد Cloudflare کپی کن.</p><label for="manualId">Cloudflare Account ID</label><input id="manualId" dir="ltr" maxlength="32" spellcheck="false" placeholder="Account ID"></details>
<div class="actions"><button class="button solid" id="cloudNext">بررسی و ادامه ←</button></div>
</form>
<form class="step" id="chatForm" autocomplete="off" hidden>
<h2>مقصد پیام را مشخص کن</h2><p class="muted small">شناسهٔ عددی گفتگوی خودت یا گفتگوی ادمین را وارد کن. برای گروه، علامت منفی ابتدای شناسه را هم بگذار.</p>
<div class="field"><label for="chatId">شناسهٔ چت یا ادمین</label><input id="chatId" dir="ltr" required maxlength="17" spellcheck="false" placeholder="123456789"></div>
<details class="guide"><summary>شناسهٔ چت را از کجا پیدا کنم؟</summary><p>در چت ربات <code>/start</code> بفرست. اگر ربات هنوز وب‌هوک ندارد، با روش <a href="https://core.telegram.org/bots/api#getupdates" target="_blank" rel="noopener noreferrer">getUpdates</a> مقدار <code>message.chat.id</code> را در پاسخ خصوصی پیدا کن. برای رباتی که از قبل وب‌هوک دارد، همین مقدار را از دریافت‌کنندهٔ فعلی‌اش بخوان.</p></details>
<div class="actions"><button class="button solid">ادامه ←</button><button class="button ghost" type="button" data-back="0">بازگشت</button></div>
</form>
<form class="step" id="botForm" autocomplete="off" hidden>
<h2>ربات تلگرام را معرفی کن</h2><p class="muted small">در <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">BotFather</a> دستور <code>/newbot</code> را بزن یا توکن ربات موجودت را کپی کن. قبل از تست، چت ربات را باز کن و <code>/start</code> بفرست.</p>
<div class="field"><label for="botToken">توکن ربات تلگرام</label><div class="input"><input id="botToken" type="password" dir="ltr" required maxlength="130" autocomplete="off" spellcheck="false" placeholder="123456789:ABC…"><button class="toggle" type="button" data-toggle="botToken" aria-pressed="false">نمایش</button></div></div>
<div class="actions"><button class="button solid">مرور و ساخت ←</button><button class="button ghost" type="button" data-back="1">بازگشت</button></div>
</form>
<section class="step" id="launch" hidden>
<h2 id="launchTitle">آمادهٔ ساخت درگاه</h2>
<p class="muted small" id="summary"></p>
<div class="guide" id="launchGuide">یک Worker تازه ساخته می‌شود. اگر حساب هنوز زیردامنهٔ <span class="ltr">workers.dev</span> ندارد، راه‌انداز ابتدا تلاش می‌کند همان را ثبت کند.</div>
<div class="actions" id="launchActions"><button class="button solid" id="deployButton" type="button">ساخت و فعال‌سازی</button><button class="button ghost" id="backButton" type="button" data-back="2">بازگشت</button></div>
<div class="status" id="status" role="status" aria-live="polite" hidden></div>
<label class="check" id="replaceLine" hidden><input id="replace" type="checkbox">وب‌هوک قبلی این ربات را با درگاه جدید جایگزین کن.</label>
<div class="actions" id="retryActions" hidden><button class="button solid" id="retry" type="button">تست مجدد وب‌هوک</button><a id="openGateway" class="button ghost" target="_blank" rel="noopener noreferrer">باز کردن صفحهٔ درگاه ↗</a></div>
<a id="openDashboard" class="button ghost" target="_blank" rel="noopener noreferrer" hidden>راه‌اندازی workers.dev در داشبورد ↗</a>
<section class="output" id="output" hidden aria-label="اطلاعات اتصال">
<h2 class="ready">وب‌هوک تأیید شد</h2><p class="muted small">پرامپت کامل را در گفت‌وگوی خصوصی ChatGPT وارد کن تا مهارت را بسازد و یک پیام آزمایشی بفرستد. برای بررسی دریافت هم می‌توانی در <a id="openBot" target="_blank" rel="noopener noreferrer">چت ربات</a> دستور <code>/start</code> بفرستی.</p>
<div class="field"><label for="sendUrl">آدرس ارسال پیام</label><div class="input"><input id="sendUrl" dir="ltr" readonly><button type="button" class="toggle" data-copy="sendUrl">کپی</button></div></div>
<div class="field"><label for="gatewayKey">کلید API درگاه</label><div class="input"><input id="gatewayKey" dir="ltr" type="password" readonly><button type="button" class="toggle" data-toggle="gatewayKey" aria-pressed="false">نمایش</button><button type="button" class="toggle" data-copy="gatewayKey">کپی</button></div></div>
<div class="field"><label for="prompt">پرامپت کامل ساخت مهارت ChatGPT</label><textarea id="prompt" dir="ltr" rows="7" spellcheck="false" readonly aria-describedby="promptPrivacy"></textarea></div>
<p class="muted small" id="promptPrivacy">پرامپت و فایل دانلودی شامل کلید واقعی درگاه‌اند. آن‌ها را خصوصی نگه دار.</p>
<div class="actions"><button class="button solid" type="button" data-copy="prompt">کپی پرامپت</button><button class="button ghost" type="button" id="savePrompt">ذخیرهٔ پرامپت</button></div>
</section>
</section>
<div class="notice" id="errorBox" role="alert" hidden></div>
</section>
<aside class="radial" aria-label="راهنمای مرحلهٔ جاری">
<div class="diagram" aria-hidden="true"><span class="orbit outer"></span><span class="orbit"></span><div class="core" id="illustration">↗</div></div>
<h2 id="asideTitle">درگاه روی حساب خودت</h2><p id="asideText">دسترسی انتخاب‌شده برای ساخت Worker و پیدا کردن حساب استفاده می‌شود.</p>
</aside>
</div></main>
<footer>این صفحه کلیدها را در مرورگر ذخیره نمی‌کند. توکن ربات و کلید درگاه در Worker مقصد به‌صورت Secret ثبت می‌شوند.</footer>
</div><div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
<script nonce="${nonce}">(${ui.toString()})();</script>
</body></html>`;
}

function ui() {
  const $ = id => document.getElementById(id);
  const stages = ["cloudForm", "chatForm", "botForm", "launch"];
  const guide = [
    ["↗", "درگاه روی حساب خودت", "دسترسی انتخاب‌شده برای ساخت Worker و پیدا کردن حساب استفاده می‌شود."],
    ["#", "یک مقصد مشخص", "درگاه فقط به شناسهٔ چتی که اینجا انتخاب می‌کنی پیام می‌فرستد."],
    ["✦", "معرفی بات", "BotFather توکن ربات را می‌دهد. راه‌انداز قبل از ساخت، اعتبار توکن را از تلگرام بررسی می‌کند."],
    ["✓", "ساخت و بررسی", "پس از انتشار، آدرس عمومی Worker به‌دست می‌آید و تلگرام ثبت وب‌هوک را تأیید می‌کند."],
  ];
  let accountId = "";
  let accountName = "";
  let deployment;
  let busy = false;
  let draft;
  let toastTimer;

  const words = {
    invalid_cf_token: "توکن Cloudflare را از فرم ساخت توکن کپی کن.",
    invalid_deploy_input: "مقادیر را بررسی کن و دوباره تلاش کن.",
    bot_token_invalid: "تلگرام توکن ربات را نپذیرفت. توکن را از BotFather دوباره کپی کن.",
    telegram_preflight: "بررسی توکن در تلگرام کامل نشد. چند ثانیه صبر کن و دوباره تلاش کن.",
    subdomain_setup: "ثبت خودکار workers.dev کامل نشد. حساب را در داشبورد باز کن، راه‌اندازی Workers و انتخاب زیردامنه را انجام بده، سپس دوباره ساخت را بزن.",
    cloudflare_network: "اتصال به API کلودفلر کامل نشد. چند ثانیه صبر کن و دوباره تلاش کن.",
    webhook_conflict: "این ربات به یک وب‌هوک دیگر وصل است. اگر می‌خواهی آن اتصال جابه‌جا شود، گزینهٔ جایگزینی را فعال کن و تست مجدد را بزن.",
    telegram_unavailable: "Worker هنوز نتوانست ثبت وب‌هوک را از تلگرام تأیید کند. چند ثانیه بعد تست مجدد را بزن.",
    webhook_unverified: "تلگرام آدرس جدید را هنوز تأیید نکرد. چند ثانیه بعد تست مجدد را بزن.",
    activation_network: "مرورگر به درگاه تازه دسترسی پیدا نکرد. چند ثانیه صبر کن و دوباره تست کن. اگر آدرس درگاه فقط با فیلترشکن باز می‌شود، فیلترشکن را روشن کن و به همین صفحه برگرد.",
    edge_blocked: "Cloudflare درخواست را پیش از رسیدن به Worker با کد ۱۰۱۰ رد کرد. جزئیات دسترسی دامنه را در داشبورد بررسی کن.",
    unauthorized: "درگاه کلید را نپذیرفت. کمی صبر کن تا انتشار نسخه کامل شود و دوباره تست کن.",
  };

  function showError(message = "") {
    $("errorBox").textContent = message;
    $("errorBox").hidden = !message;
  }

  function status(message = "", state = "") {
    $("status").textContent = message;
    $("status").className = "status " + state;
    $("status").hidden = !message;
  }

  function toast(message) {
    const box = $("toast");
    clearTimeout(toastTimer);
    box.textContent = message;
    box.classList.add("visible");
    toastTimer = setTimeout(() => box.classList.remove("visible"), 2600);
  }

  function step(number) {
    showError();
    stages.forEach((id, index) => { $(id).hidden = index !== number; });
    [...$("progress").children].forEach((item, index) => {
      item.classList.toggle("done", index < number);
      if (index === number) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    const [symbol, title, detail] = guide[number];
    $("illustration").textContent = symbol;
    $("asideTitle").textContent = title;
    $("asideText").textContent = detail;
    if (window.matchMedia("(max-width: 770px)").matches) $("progress").scrollIntoView({ block: "nearest" });
  }

  function explain(error) {
    const info = error.info || {};
    if (info.code === "cloudflare_error") {
      if (info.upstreamStatus === 429) return "Cloudflare درخواست‌های زیادی دریافت کرده. چند ثانیه بعد دوباره تلاش کن.";
      if (info.cloudflareCodes?.includes(10015)) return "دسترسی Workers هنوز برای این حساب فعال نیست. از داشبورد حساب، راه‌اندازی Workers را انجام بده و دوباره تلاش کن.";
      const message = info.upstreamStatus === 401 || info.upstreamStatus === 403
        ? "Cloudflare دسترسی را نپذیرفت. حساب مقصد، اعتبار توکن و مجوزهای Workers Scripts و Account Settings را بررسی کن."
        : "Cloudflare نتوانست این مرحله را کامل کند.";
      const stage = { accounts: "فهرست حساب‌ها", subdomain: "خواندن زیردامنه", upload: "ساخت Worker",
        publish: "انتشار روی workers.dev" }[info.stage];
      return message + (stage ? " مرحلهٔ خطا: " + stage + "." : "") +
        (info.cloudflareCodes?.length ? " کد Cloudflare: " + info.cloudflareCodes.join("، ") : "");
    }
    const code = info.code || info.error;
    const base = words[code] || "درخواست کامل نشد. اتصال را بررسی کن و دوباره تلاش کن.";
    return base + (info.telegramCode ? " کد تلگرام: " + info.telegramCode : "");
  }

  async function post(url, data, apiKey, timeout = 45000) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    let response;
    try {
      response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify(data),
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw Object.assign(new Error(), { info: { code: apiKey ? "activation_network" : "cloudflare_network" } });
    }
    const raw = await response.text().catch(() => "");
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (apiKey && response.status === 403 && /\b1010\b/.test(raw)) {
      throw Object.assign(new Error(), { info: { code: "edge_blocked" } });
    }
    if (!response.ok || body?.ok !== true) {
      throw Object.assign(new Error(), { info: body || { code: apiKey ? "activation_network" : "unexpected" } });
    }
    return body;
  }

  function pickAccount(id, name) {
    accountId = id;
    accountName = name || id;
    step(1);
    $("chatId").focus();
  }

  $("cfToken").addEventListener("input", () => { $("accountField").hidden = true; });
  $("cloudForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    showError();
    const cfToken = $("cfToken").value.trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(cfToken)) return showError(words.invalid_cf_token);
    const manual = $("manualPanel").open ? $("manualId").value.trim() : "";
    if (manual) {
      if (!/^[a-f0-9]{32}$/i.test(manual)) return showError("Account ID باید ۳۲ کاراکتر هگز باشد.");
      return pickAccount(manual);
    }
    if (!$("accountField").hidden && $("account").value) {
      return pickAccount($("account").value, $("account").selectedOptions[0]?.textContent);
    }
    busy = $("cloudNext").disabled = true;
    $("cloudNext").textContent = "در حال بررسی حساب…";
    try {
      const result = await post("/api/accounts", { cfToken });
      if (!result.accounts.length) {
        $("manualPanel").open = true;
        return showError("حسابی پیدا نشد. Account ID را دستی وارد کن یا محدودهٔ توکن را بررسی کن.");
      }
      if (result.accounts.length === 1) return pickAccount(result.accounts[0].id, result.accounts[0].name);
      $("account").replaceChildren(new Option("یک حساب انتخاب کن", ""));
      for (const account of result.accounts) $("account").add(new Option(account.name || account.id, account.id));
      $("accountField").hidden = false;
      $("account").focus();
    } catch (error) {
      $("manualPanel").open = true;
      showError(explain(error));
    } finally {
      busy = $("cloudNext").disabled = false;
      $("cloudNext").textContent = "بررسی و ادامه ←";
    }
  });

  $("chatForm").addEventListener("submit", event => {
    event.preventDefault();
    const normalized = $("chatId").value.trim().replace(/[۰-۹٠-٩]/g, digit =>
      String(digit.charCodeAt(0) - (digit >= "۰" ? 1776 : 1632))).replace(/^−/, "-");
    if (!/^-?[1-9]\d{0,15}$/.test(normalized)) return showError("شناسهٔ عددی چت را وارد کن.");
    $("chatId").value = normalized;
    step(2);
    $("botToken").focus();
  });

  $("botForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!/^\d{5,20}:[A-Za-z0-9_-]{25,100}$/.test($("botToken").value.trim())) {
      return showError("قالب توکن ربات را بررسی کن و مقدار را دوباره از BotFather کپی کن.");
    }
    $("summary").textContent = "حساب مقصد: " + accountName + "  ·  شناسهٔ چت: " + $("chatId").value;
    step(3);
    $("deployButton").focus();
  });

  const randomHex = count => Array.from(crypto.getRandomValues(new Uint8Array(count)),
    byte => byte.toString(16).padStart(2, "0")).join("");

  async function activate() {
    $("retryActions").hidden = true;
    showError();
    let finalError;
    for (const delay of [0, 1600, 3500]) {
      if (delay) {
        status("در انتظار آماده شدن درگاه…", "busy");
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      status("در حال ثبت و بررسی وب‌هوک تلگرام…", "busy");
      try {
        const result = await post(deployment.workerUrl + "/registerWebhook",
          { replaceExisting: $("replace").checked }, draft.apiKey, 24000);
        if (result.url !== deployment.workerUrl + "/webhook") {
          throw Object.assign(new Error(), { info: { code: "webhook_unverified" } });
        }
        finalError = null;
        break;
      } catch (error) {
        finalError = error;
        if (error.info?.error === "webhook_conflict" || error.info?.code === "edge_blocked" ||
            [400, 401, 403].includes(error.info?.telegramCode)) break;
      }
    }
    if (finalError) {
      status("Worker منتشر شد. تأیید وب‌هوک هنوز کامل نشده است.");
      $("replaceLine").hidden = finalError.info?.error !== "webhook_conflict";
      $("retryActions").hidden = false;
      showError(explain(finalError));
      return;
    }
    $("replaceLine").hidden = true;
    status();
    $("launchTitle").textContent = "درگاه آماده است";
    $("launchGuide").hidden = true;
    const url = deployment.workerUrl + "/send";
    $("sendUrl").value = url;
    $("gatewayKey").value = draft.apiKey;
    const botName = deployment.botUsername;
    if (botName && /^[A-Za-z0-9_]{3,64}$/.test(botName)) $("openBot").href = "https://t.me/" + botName;
    $("prompt").value = [
      "@skill-creator make this skill for me:",
      "",
      "# Skill: Send Telegram notifications",
      "",
      "Create a private, reusable skill that sends plain-text messages on my behalf to the fixed Telegram chat configured by my gateway.",
      "",
      "Gateway endpoint: " + url,
      "Gateway API key: " + draft.apiKey,
      "",
      "## Save the configuration",
      "Save both the exact endpoint and the exact gateway key for use in future chats. Use a supported private secret field if skill storage provides one. Otherwise, I authorize you to save this exact key in the private skill file if the platform permits it. Keep the skill private. Do not replace the key with a placeholder or a reference to an unset environment variable. Verify what was actually persisted without displaying the key. If the platform prevents saving it, tell me plainly and name the private configuration step that is still required.",
      "",
      "## When to send",
      "- Send once when I explicitly ask you to send, forward, or notify me about something via Telegram. A request to draft a message does not authorize sending it.",
      "- When I explicitly request a connection test, send one message saying: Telegram gateway test ✅",
      "- This setup request authorizes one immediate test message after the skill creation attempt. Run it yourself with the supplied key if an outbound tool is available, even if the key could not be saved for future chats. Report whether setup and testing succeeded separately. Never repeat this setup test just because the saved skill is loaded in a new chat.",
      "",
      "## How to send",
      "- Prefer normal curl or curl.exe in an available terminal with outbound HTTPS. Otherwise use a dedicated HTTP tool that can send custom headers. Execute the request yourself when a suitable tool is available.",
      "- Send POST to the exact gateway endpoint above with Content-Type: application/json and Authorization: Bearer followed by the exact saved gateway key. Use a JSON serializer to build an object with only the text field, for example: " + JSON.stringify({ text: "Telegram gateway test ✅" }),
      "- Use the key only in the Authorization header to this endpoint. Avoid verbose output, shell tracing and redirects. Never print the key in a reply or expose it to another service.",
      "",
      "## How to report",
      "- Confirm Telegram accepted a message only on HTTP 200 with JSON ok:true. On failure, report the HTTP status and error code if available. If Cloudflare returns 403 with error 1010, say Cloudflare blocked the request before it reached the gateway.",
      "- Do not retry automatically. If no suitable tool can run the request, say no message was sent. The gateway sends only. It cannot read chats or change the destination.",
    ].join("\n");
    $("output").hidden = false;
    $("progress").lastElementChild.classList.add("done");
  }

  $("deployButton").addEventListener("click", async () => {
    if (busy) return;
    busy = $("deployButton").disabled = $("backButton").disabled = true;
    showError();
    $("openDashboard").hidden = true;
    status("در حال بررسی توکن ربات و انتشار Worker…", "busy");
    draft ||= { name: "telegram-gateway-" + randomHex(8), apiKey: randomHex(32), webhookSecret: randomHex(32) };
    try {
      deployment = await post("/api/deploy", {
        ...draft, cfToken: $("cfToken").value.trim(), accountId,
        chatId: $("chatId").value, botToken: $("botToken").value.trim(),
      });
      $("cfToken").value = $("botToken").value = "";
      $("openGateway").href = deployment.workerUrl;
      $("launchActions").hidden = true;
      $("launchTitle").textContent = "در حال فعال‌سازی وب‌هوک";
      await activate();
    } catch (error) {
      status();
      showError(explain(error));
      if (error.info?.code === "subdomain_setup" ||
          error.info?.cloudflareCodes?.includes(10015) ||
          ["subdomain", "create_subdomain", "publish"].includes(error.info?.stage)) {
        $("openDashboard").href = "https://dash.cloudflare.com/" + accountId + "/workers-and-pages";
        $("openDashboard").hidden = false;
      }
    } finally {
      busy = $("deployButton").disabled = $("backButton").disabled = false;
    }
  });

  $("retry").addEventListener("click", async () => {
    if (!deployment || busy) return;
    busy = $("retry").disabled = true;
    try { await activate(); }
    finally { busy = $("retry").disabled = false; }
  });

  for (const button of document.querySelectorAll("[data-back]")) {
    button.addEventListener("click", () => { if (!busy) step(Number(button.dataset.back)); });
  }
  for (const button of document.querySelectorAll("[data-toggle]")) {
    button.addEventListener("click", () => {
      const input = $(button.dataset.toggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "پنهان" : "نمایش";
      button.setAttribute("aria-pressed", String(show));
    });
  }
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const input = $(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(input.value);
        toast({
          gatewayKey: "کلید API درگاه کپی شد.",
          prompt: "پرامپت کامل کپی شد.",
          sendUrl: "آدرس درگاه کپی شد.",
        }[button.dataset.copy]);
      } catch {
        if (input.type === "password") {
          const toggle = document.querySelector('[data-toggle="gatewayKey"]');
          toggle?.click();
        }
        input.focus();
        input.select();
        toast("متن انتخاب شد. آن را دستی کپی کن.");
      }
    });
  }
  $("savePrompt").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([$("prompt").value], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "telegram-gateway-prompt.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
