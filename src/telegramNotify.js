const fetch = require("node-fetch");

/** Escape dynamic segments for Telegram Bot API `parse_mode: "Markdown"` (legacy). */
function escapeTelegramMarkdown(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_");
}

/**
 * Send a plain-text or Markdown message to the configured admin Telegram chat.
 * @param {string} message
 * @returns {Promise<void>}
 */
async function sendTelegramNotification(message) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    const err = new Error("Telegram bot is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).");
    err.code = "TELEGRAM_NOT_CONFIGURED";
    throw err;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(message || "").slice(0, 4096),
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    const err = new Error(data.description || `Telegram API error (${res.status})`);
    err.code = "TELEGRAM_SEND_FAILED";
    err.telegramBody = data;
    throw err;
  }
}

module.exports = { sendTelegramNotification, escapeTelegramMarkdown };
