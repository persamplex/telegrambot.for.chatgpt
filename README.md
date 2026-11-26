# Telegram Bot for ChatGPT

A minimal, self-hosted, one-way HTTP gateway on Cloudflare Workers. An AI assistant or other authorized client can send text notifications through a personal Telegram bot to a fixed administrator chat. The manual Worker sends notifications. The automatic installer also configures a webhook so you can test delivery with `/start`.

## Automatic setup

[Open the Persian installer](https://late-morning-badd.isfwic1.workers.dev/)

Create a Cloudflare API token from the installer, select your account, and enter your Telegram chat ID and bot token. The installer deploys the gateway to your account, verifies the webhook, and provides the gateway URL, API key, and a ready-to-copy ChatGPT skill prompt. The prompt contains the gateway key, so keep it private.

To host the installer yourself, deploy [`telegram-setup-worker.js`](telegram-setup-worker.js) as a Cloudflare Worker.

## Manual setup

1. Create a bot with @BotFather. Start a conversation with your bot and obtain your numeric Telegram chat ID (for example, using Telegram's getUpdates API privately).
2. Create a Cloudflare Worker and paste the contents of worker.js into its editor.
3. Replace the three placeholder constants in the private deployed copy: TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, API_KEY. Use a long random API key.
4. Deploy and copy the HTTPS Worker URL.

Keep real credentials out of GitHub and public prompts. Inline configuration is provided for simple installation; Cloudflare Secrets are preferable for production. Rotate exposed credentials.

## API
POST /send with Authorization: Bearer YOUR_API_KEY and Content-Type: application/json.
Body: {"text":"Hello from ChatGPT"}.
The destination is fixed in the Worker; clients cannot override it. Text must be nonempty and at most 4096 UTF-16 code units.

Example:
```sh
curl -X POST https://YOUR-WORKER.workers.dev/send \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from ChatGPT"}'
```

Success: HTTP 200 with {"ok":true}. Errors return JSON with ok:false and an error code. Telegram acceptance is not proof the recipient read the message.

## Example AI skill prompt
```text
You have a one-way Telegram notification gateway at https://YOUR-WORKER.workers.dev/send.
When the user authorizes sending a notification, use your available HTTP action to POST JSON {"text":"<message>"} with Content-Type: application/json and Authorization: Bearer <securely configured API key>.
Never change the destination, expose credentials, or send without authorization. Report success only if HTTP 200 and ok:true are returned. Do not claim to read Telegram messages. Do not blindly retry ambiguous failures.
If no HTTP action is available, explain the limitation instead of claiming delivery.
```
For this manual example, configure the key securely in the HTTP tool. A prompt alone cannot grant network access; a compatible HTTP tool or configured GPT Action is required.

## Status
Initial prototype. Rate limiting and a standalone OpenAPI schema are planned, not implemented. Configure rate limiting before exposing the gateway to production traffic. See [فارسی](README.fa.md).
