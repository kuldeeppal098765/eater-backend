const { Server } = require("socket.io");
const { Telegraf } = require("telegraf");
const { escapeTelegramMarkdown } = require("./telegramNotify");

/** Maps Telegram `message_id` (admin chat) → Socket.IO client id for reply routing. */
const activeChats = new Map();

let ioInstance = null;
let telegrafBot = null;

function removeSocketFromChatMap(socketId) {
  for (const [telegramMsgId, sid] of activeChats.entries()) {
    if (sid === socketId) activeChats.delete(telegramMsgId);
  }
}

function parseSocketCorsOrigin() {
  const raw = String(process.env.SOCKET_CORS_ORIGIN || "").trim();
  if (!raw) return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Attach Socket.IO + Telegram bot to the same HTTP server as Express.
 * Admin must **reply in Telegram** to the bot message that carried the user line.
 */
function attachLiveChatSocket(httpServer) {
  if (ioInstance) {
    console.warn("[live-chat] attachLiveChatSocket called more than once — skipping.");
    return ioInstance;
  }

  ioInstance = new Server(httpServer, {
    path: "/socket.io/",
    cors: {
      origin: parseSocketCorsOrigin(),
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const adminChatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();

  if (token && adminChatId) {
    const bot = new Telegraf(token);
    telegrafBot = bot;

    bot.on("message", (ctx) => {
      try {
        if (String(ctx.chat?.id) !== adminChatId) return;
        const replyTo = ctx.message?.reply_to_message;
        if (!replyTo || typeof replyTo.message_id !== "number") return;

        const targetSocketId = activeChats.get(replyTo.message_id);
        if (!targetSocketId || !ioInstance) return;

        const text =
          ctx.message?.text != null
            ? String(ctx.message.text)
            : ctx.message?.caption != null
              ? String(ctx.message.caption)
              : "";
        if (!text.trim()) return;

        ioInstance.to(targetSocketId).emit("admin_reply", text);
      } catch (e) {
        console.error("[live-chat] Telegram message handler:", e?.message || e);
      }
    });

    bot
      .launch()
      .then(() => console.log("[live-chat] Telegram bot polling (admin replies via Reply)."))
      .catch((e) => console.error("[live-chat] Telegram bot failed to start:", e?.message || e));

    const stopBot = () => {
      try {
        bot.stop("SIGINT");
      } catch {
        /* ignore */
      }
    };
    process.once("SIGINT", stopBot);
    process.once("SIGTERM", stopBot);
  } else {
    console.warn(
      "[live-chat] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — user messages will not reach Telegram.",
    );
  }

  ioInstance.on("connection", (socket) => {
    socket.on("disconnect", () => {
      removeSocketFromChatMap(socket.id);
    });

    socket.on("user_message", async (raw) => {
      const name = String(raw?.name || "").trim().slice(0, 120);
      const role = String(raw?.role || "").trim().slice(0, 64);
      const phone = String(raw?.phone || "").trim().slice(0, 32);
      const text = String(raw?.text || "").trim().slice(0, 3800);

      if (!text) {
        socket.emit("chat_error", { message: "Message cannot be empty." });
        return;
      }

      if (!token || !adminChatId) {
        socket.emit("chat_error", { message: "Live chat is not configured on the server." });
        return;
      }

      if (!telegrafBot) {
        socket.emit("chat_error", { message: "Live chat bot is unavailable." });
        return;
      }

      try {
        const n = escapeTelegramMarkdown(name || "—");
        const r = escapeTelegramMarkdown(role || "—");
        const t = escapeTelegramMarkdown(text);
        const body = `💬 *${r} ${n}*: ${t}`;

        const sent = await telegrafBot.telegram.sendMessage(adminChatId, body, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });

        if (sent && typeof sent.message_id === "number") {
          activeChats.set(sent.message_id, socket.id);
        }
        socket.emit("chat_delivered", { ok: true });
      } catch (e) {
        console.error("[live-chat] user_message → Telegram:", e?.message || e);
        socket.emit("chat_error", {
          message: e?.message || "Could not deliver your message. Try again.",
        });
      }
    });
  });

  return ioInstance;
}

module.exports = { attachLiveChatSocket, activeChats };
