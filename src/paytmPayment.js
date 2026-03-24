/**
 * Paytm sandbox / production helpers: start a payment (get txn token) and verify the callback.
 * Uses Paytm’s checksum rules via the official `paytmchecksum` package.
 */

/** Official Paytm Node helper — default export is the PaytmChecksum class */
const PaytmChecksum = require("paytmchecksum");

/** Staging: must match Paytm test dashboard (do not use securegw.paytm.in for test MID). */
const PAYTM_STAGING_INITIATE_URL = "https://securegw-stage.paytm.in/theia/api/v1/initiateTransaction";
const PAYTM_PRODUCTION_INITIATE_URL = "https://securegw.paytm.in/theia/api/v1/initiateTransaction";

function isPaytmProductionEnv() {
  const env = String((process.env.PAYTM_ENV || "sandbox").trim()).toLowerCase();
  return env === "production" || env === "prod";
}

function getPaytmInitiateTransactionUrl() {
  return isPaytmProductionEnv() ? PAYTM_PRODUCTION_INITIATE_URL : PAYTM_STAGING_INITIATE_URL;
}

/**
 * Paytm expects a plain customer reference — letters and digits only, max 64.
 */
function paytmSafeCustId(userId) {
  let s = String(userId || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!s) s = "CUST";
  return s.length > 64 ? s.slice(0, 64) : s;
}

/**
 * Paytm treats merchant orderId as unique per payment attempt. Reusing the same id
 * (e.g. human-readable orderNumber) on "Pay again" causes initiate to fail.
 * We send: 32-char uuid without hyphens + "_" + millis (≤50 chars), and map it back on callback.
 */
function buildPaytmMerchantOrderId(internalOrderId) {
  const compact = String(internalOrderId || "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  const id = `${compact}_${Date.now()}`;
  return id.length <= 50 ? id : id.slice(0, 50);
}

function internalOrderIdFromPaytmMerchantOrderId(merchantOrderId) {
  const s = String(merchantOrderId || "").trim();
  const i = s.lastIndexOf("_");
  if (i <= 0) return null;
  const ts = s.slice(i + 1);
  if (!/^\d{10,16}$/.test(ts)) return null;
  const compact = s.slice(0, i);
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20, 32)}`;
}

function getPaytmBaseUrl() {
  return isPaytmProductionEnv() ? "https://securegw.paytm.in" : "https://securegw-stage.paytm.in";
}

function resolveCallbackUrl() {
  const direct = (process.env.PAYTM_CALLBACK_URL || "").trim();
  if (direct) return direct;
  const base = (process.env.APP_PUBLIC_URL || "").trim() || (process.env.PUBLIC_API_BASE_URL || "").trim();
  if (base) {
    return `${base.replace(/\/$/, "")}/api/payment/paytm-callback`;
  }
  return "";
}

function getPaytmConfig() {
  return {
    mid: (process.env.PAYTM_MID || "").trim(),
    merchantKey: (process.env.PAYTM_MERCHANT_KEY || "").trim(),
    website: (process.env.PAYTM_WEBSITE || "WEBSTAGING").trim(),
    callbackUrl: resolveCallbackUrl(),
    baseUrl: getPaytmBaseUrl(),
  };
}

function isPaytmReady() {
  const c = getPaytmConfig();
  return Boolean(c.mid && c.merchantKey && c.website && c.callbackUrl);
}

/**
 * Turn callback fields into plain strings so Paytm’s checksum helper never calls string helpers on numbers.
 */
function normalizeCallbackParams(body) {
  const out = {};
  if (!body || typeof body !== "object") return out;
  for (const [key, value] of Object.entries(body)) {
    if (key === "CHECKSUMHASH") continue;
    out[key] = value == null ? "" : String(value);
  }
  return out;
}

/**
 * Check whether the callback checksum matches Paytm’s secret key (detect tampering).
 */
function verifyPaytmCallbackChecksum(body, merchantKey) {
  const checksum = String(body?.CHECKSUMHASH ?? "").trim();
  if (!checksum || !merchantKey) return false;
  const params = normalizeCallbackParams(body);
  return PaytmChecksum.verifySignature(params, merchantKey, checksum) === true;
}

/**
 * Call Paytm “Initiate Transaction” and return the txn token for JS Checkout.
 */
async function initiatePaytmForOrder(prisma, { orderId, userId }) {
  try {
    const cfg = getPaytmConfig();
    if (!isPaytmReady()) {
      const err = new Error(
        "Paytm is not configured. Set PAYTM_MID, PAYTM_MERCHANT_KEY, PAYTM_WEBSITE, and PAYTM_CALLBACK_URL (or APP_PUBLIC_URL).",
      );
      err.code = "PAYTM_NOT_CONFIGURED";
      throw err;
    }

    const oid = String(orderId || "").trim();
    const uid = String(userId || "").trim();
    if (!oid || !uid) {
      const err = new Error("orderId and userId are required");
      err.code = "BAD_REQUEST";
      throw err;
    }

    const order = await prisma.order.findUnique({
      where: { id: oid },
      include: { user: { select: { id: true, phone: true, email: true, name: true } } },
    });
    if (!order) {
      const err = new Error("Order not found");
      err.code = "NOT_FOUND";
      throw err;
    }
    if (order.userId !== uid) {
      const err = new Error("This order does not belong to the given user");
      err.code = "FORBIDDEN";
      throw err;
    }
    if (order.status === "CANCELLED") {
      const err = new Error("Cannot pay for a cancelled order");
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (String(order.paymentStatus).toUpperCase() === "PAID") {
      const err = new Error("This order is already marked as paid");
      err.code = "BAD_REQUEST";
      throw err;
    }

    const paytmOrderId = buildPaytmMerchantOrderId(order.id);
    if (!paytmOrderId) {
      const err = new Error("Could not build Paytm order id from internal order");
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (paytmOrderId.length > 50) {
      const err = new Error("Paytm order reference is too long (max 50 characters)");
      err.code = "BAD_REQUEST";
      throw err;
    }

    const totalNum = Number(order.totalAmount);
    /** Paytm requires txn amount as a string (e.g. "1.00"), not a JSON number */
    const amountStr = Number.isFinite(totalNum) ? String(totalNum.toFixed(2)) : "";
    if (!amountStr || !Number.isFinite(Number(amountStr)) || Number(amountStr) <= 0) {
      const err = new Error("Invalid order amount");
      err.code = "BAD_REQUEST";
      throw err;
    }

    const paytmBody = {
      requestType: "Payment",
      mid: cfg.mid,
      websiteName: cfg.website,
      orderId: paytmOrderId,
      callbackUrl: cfg.callbackUrl,
      txnAmount: {
        value: String(totalNum.toFixed(2)),
        currency: "INR",
      },
      userInfo: {
        custId: paytmSafeCustId(uid),
      },
    };

    const bodyString = JSON.stringify(paytmBody);

    let signature;
    try {
      signature = await PaytmChecksum.generateSignature(bodyString, cfg.merchantKey);
    } catch (sigErr) {
      const msg =
        typeof sigErr === "string"
          ? sigErr
          : sigErr?.message || "Paytm checksum (signature) generation failed";
      console.error("[Paytm initiate] generateSignature error:", msg, sigErr);
      const err = new Error(msg);
      err.code = "PAYTM_CHECKSUM_ERROR";
      err.cause = sigErr;
      throw err;
    }

    if (signature == null || String(signature).trim() === "") {
      console.error("[Paytm initiate] generateSignature returned empty signature");
      const err = new Error("Paytm checksum generation returned an empty signature");
      err.code = "PAYTM_CHECKSUM_ERROR";
      throw err;
    }

    /** Send the exact `body` JSON bytes that were checksummed inside the envelope (avoids Axios re-ordering keys). */
    const requestEnvelope = `{"body":${bodyString},"head":{"signature":${JSON.stringify(String(signature))}}}`;

    const initiateBase = getPaytmInitiateTransactionUrl();
    const url = `${initiateBase}?mid=${encodeURIComponent(cfg.mid)}&orderId=${encodeURIComponent(paytmOrderId)}`;

    let data;
    let httpStatus = 0;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: requestEnvelope,
      });
      httpStatus = response.status;
      const rawText = await response.text();
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = rawText;
      }
    } catch (netErr) {
      console.error("[Paytm initiate] Fetch request failed:", netErr?.message || netErr);
      const err = new Error(netErr?.message || "Paytm initiate network error");
      err.code = "PAYTM_BAD_RESPONSE";
      err.detail = "";
      throw err;
    }

    if (data == null || typeof data !== "object") {
      console.error("[Paytm initiate] Non-JSON or empty response from Paytm, HTTP", httpStatus);
      const err = new Error("Paytm returned a non-JSON response");
      err.code = "PAYTM_BAD_RESPONSE";
      err.detail = "";
      throw err;
    }

    const inner = data.body || {};
    const resultInfo = inner.resultInfo || {};
    const status = String(resultInfo.resultStatus || "").toUpperCase();

    const httpOk = httpStatus >= 200 && httpStatus < 300;
    if (!httpOk || status !== "S") {
      const msg =
        resultInfo.resultMsg ||
        inner.message ||
        `Paytm initiate failed (${httpStatus})`;
      console.error("[Paytm initiate] Paytm API error:", {
        httpStatus,
        resultStatus: status,
        resultCode: resultInfo.resultCode,
        resultMsg: resultInfo.resultMsg,
        orderId: paytmOrderId,
        amount: amountStr,
      });
      const err = new Error(msg);
      err.code = "PAYTM_INIT_FAILED";
      err.resultCode = resultInfo.resultCode;
      err.paytmRaw = data;
      throw err;
    }

    const txnToken = inner.txnToken;
    if (!txnToken) {
      console.error("[Paytm initiate] Success status but missing txnToken. body:", JSON.stringify(inner).slice(0, 400));
      const err = new Error("Paytm did not return a transaction token");
      err.code = "PAYTM_NO_TOKEN";
      throw err;
    }

    return {
      txnToken,
      mid: cfg.mid,
      orderId: paytmOrderId,
      amount: amountStr,
      currency: "INR",
      website: cfg.website,
      environment: String(process.env.PAYTM_ENV || "sandbox").toLowerCase(),
      /** What you pass into Paytm JS Checkout on the browser */
      checkoutHints: {
        token: txnToken,
        amount: amountStr,
        orderId: paytmOrderId,
      },
    };
  } catch (err) {
    const code = err?.code || "";
    const alreadyLogged =
      code === "PAYTM_INIT_FAILED" ||
      code === "PAYTM_BAD_RESPONSE" ||
      code === "PAYTM_NO_TOKEN" ||
      code === "PAYTM_CHECKSUM_ERROR";
    if (
      !alreadyLogged &&
      code !== "BAD_REQUEST" &&
      code !== "NOT_FOUND" &&
      code !== "FORBIDDEN" &&
      code !== "PAYTM_NOT_CONFIGURED"
    ) {
      console.error("[Paytm initiate] Error:", err?.message || err);
      if (err?.stack) console.error(err.stack);
      if (err?.detail) console.error("[Paytm initiate] detail:", err.detail);
      if (err?.resultCode != null) console.error("[Paytm initiate] resultCode:", err.resultCode);
    }
    throw err;
  }
}

/**
 * After Paytm posts back to your server, verify the checksum and update the order row.
 */
async function handlePaytmCallback(prisma, body) {
  const cfg = getPaytmConfig();
  if (!cfg.merchantKey) {
    const err = new Error("Paytm merchant key is not configured");
    err.code = "PAYTM_NOT_CONFIGURED";
    throw err;
  }

  if (!verifyPaytmCallbackChecksum(body, cfg.merchantKey)) {
    const err = new Error("Invalid payment checksum — request was rejected");
    err.code = "CHECKSUM_FAIL";
    throw err;
  }

  const orderRef = String(body.ORDERID || "").trim();
  const txnId = String(body.TXNID || "").trim();
  const status = String(body.STATUS || "").trim();
  const txnAmount = String(body.TXNAMOUNT || "").trim();
  const respMsg = String(body.RESPMSG || body.RESPONSEMSG || "").trim();

  if (!orderRef) {
    const err = new Error("ORDERID missing from Paytm callback");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const fromEmbeddedUuid = internalOrderIdFromPaytmMerchantOrderId(orderRef);
  const order = await prisma.order.findFirst({
    where: {
      OR: [
        ...(fromEmbeddedUuid ? [{ id: fromEmbeddedUuid }] : []),
        { orderNumber: orderRef },
        { id: orderRef },
      ],
    },
  });

  if (!order) {
    const err = new Error("No matching order for this payment");
    err.code = "NOT_FOUND";
    throw err;
  }

  const expectedNum = Number(order.totalAmount);
  if (txnAmount) {
    const paidNum = Number(txnAmount);
    if (Number.isFinite(paidNum) && Number.isFinite(expectedNum) && Math.abs(paidNum - expectedNum) > 0.02) {
      const err = new Error("Paid amount does not match order total");
      err.code = "AMOUNT_MISMATCH";
      throw err;
    }
  }

  if (status === "TXN_SUCCESS") {
    const wasOnlineUnpaid =
      String(order.paymentMethod || "").toUpperCase() === "ONLINE" &&
      String(order.paymentStatus || "").toUpperCase() !== "PAID";
    const successUpdate = {
      paymentStatus: "PAID",
      paymentMethod: "ONLINE",
      paytmTxnId: txnId || order.paytmTxnId,
    };
    if (String(order.status || "").toUpperCase() === "PAYMENT_FAILED") {
      successUpdate.status = "PENDING";
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: successUpdate,
    });
    return {
      ok: true,
      orderId: updated.id,
      orderNumber: updated.orderNumber,
      paymentStatus: updated.paymentStatus,
      paytmStatus: status,
      message: respMsg || "Payment successful",
      /** Internal: first-time online settlement — server should ping kitchen + riders */
      notifyRestaurantKitchen: wasOnlineUnpaid,
    };
  }

  // Paytm still processing — do not mark paid or failed yet
  if (status === "PENDING" || status === "TXN_PENDING") {
    return {
      ok: false,
      pending: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      paytmStatus: status,
      message: respMsg || "Payment is still in progress",
    };
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: "FAILED",
      paymentMethod: "ONLINE",
      status: "PAYMENT_FAILED",
    },
  });

  return {
    ok: false,
    orderId: updated.id,
    orderNumber: updated.orderNumber,
    paymentStatus: updated.paymentStatus,
    paytmStatus: status,
    message: respMsg || "Payment did not complete",
  };
}

module.exports = {
  getPaytmConfig,
  isPaytmReady,
  initiatePaytmForOrder,
  handlePaytmCallback,
  verifyPaytmCallbackChecksum,
};
