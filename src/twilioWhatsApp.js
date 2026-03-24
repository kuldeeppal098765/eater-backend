/**
 * Twilio WhatsApp (Content API / approved template) for OTP.
 * Configure via env — never commit secrets.
 *
 * Template must include a variable for the OTP (default placeholder key "1").
 * Example contentVariables: {"1":"1234"}
 */
const twilio = require("twilio");

function isTwilioWhatsAppConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_WHATSAPP_FROM?.trim() &&
      process.env.TWILIO_WHATSAPP_CONTENT_SID?.trim(),
  );
}

/**
 * @param {object} opts
 * @param {string} opts.phoneDigits10 — national number without country code (e.g. 8299393771)
 * @param {string} opts.otp4 — OTP code string (e.g. 4–8 digits per OTP_CODE_LENGTH)
 * @returns {Promise<string>} Message SID
 */
async function sendWhatsAppOtpTemplate({ phoneDigits10, otp4 }) {
  if (!isTwilioWhatsAppConfigured()) {
    throw new Error("Twilio WhatsApp is not configured (missing env vars)");
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN.trim();
  const from = process.env.TWILIO_WHATSAPP_FROM.trim();
  const contentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID.trim();

  const cc = String(process.env.TWILIO_PHONE_COUNTRY_PREFIX || "91").replace(/\D/g, "") || "91";
  const national = String(phoneDigits10 || "").replace(/\D/g, "");
  if (national.length < 10) {
    throw new Error("Invalid phone for WhatsApp");
  }

  const to = `whatsapp:+${cc}${national.slice(-10)}`;

  const otpVarKey = String(process.env.TWILIO_WHATSAPP_OTP_VAR || "1").trim() || "1";
  /** @type {Record<string, string>} */
  const vars = { [otpVarKey]: String(otp4) };

  if (process.env.TWILIO_WHATSAPP_EXTRA_VARS_JSON?.trim()) {
    try {
      const extra = JSON.parse(process.env.TWILIO_WHATSAPP_EXTRA_VARS_JSON);
      if (extra && typeof extra === "object") {
        for (const [k, v] of Object.entries(extra)) {
          vars[String(k)] = String(v);
        }
      }
    } catch (e) {
      throw new Error(`TWILIO_WHATSAPP_EXTRA_VARS_JSON must be valid JSON: ${e.message}`);
    }
  }

  const client = twilio(accountSid, authToken);

  const message = await client.messages.create({
    from,
    to,
    contentSid,
    contentVariables: JSON.stringify(vars),
  });

  return message.sid;
}

module.exports = {
  isTwilioWhatsAppConfigured,
  sendWhatsAppOtpTemplate,
};
