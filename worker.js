// Initial prototype. Replace placeholders only in your private deployed copy.
const TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN";
const ADMIN_CHAT_ID = "YOUR_ADMIN_CHAT_ID";
const API_KEY = "YOUR_LONG_RANDOM_API_KEY";

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== "/send")
      return json({ ok: false, error: "not_found" }, 404);
    if (request.method !== "POST")
      return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
    if ([TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, API_KEY].some(v => !v || v.startsWith("YOUR_")))
      return json({ ok: false, error: "not_configured" }, 503);
    if (request.headers.get("Authorization") !== `Bearer ${API_KEY}`)
      return json({ ok: false, error: "unauthorized" }, 401);
    if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      return json({ ok: false, error: "unsupported_media_type" }, 415);

    let body;
    try {
      const reader = request.body?.getReader();
      if (!reader) return json({ ok: false, error: "invalid_json" }, 400);
      let bytes = 0;
      const decoder = new TextDecoder();
      let raw = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32768) {
          await reader.cancel();
          return json({ ok: false, error: "payload_too_large" }, 413);
        }
        raw += decoder.decode(value, { stream: true });
      }
      body = JSON.parse(raw + decoder.decode());
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    if (!body || typeof body.text !== "string" || !body.text.trim() ||
        body.text.length > 4096 || Object.keys(body).some(k => k !== "text"))
      return json({ ok: false, error: "invalid_text" }, 400);

    // TODO: configure rate limiting before production use.
    try {
      const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: body.text }),
        redirect: "error",
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true)
        return json({ ok: false, error: "telegram_rejected" }, 502);
      return json({ ok: true });
    } catch {
      return json({ ok: false, error: "telegram_unavailable" }, 502);
    }
  },
};
