const jwt = require("jsonwebtoken");

const DEV_FALLBACK_SECRET = "fresto-dev-only-change-me";

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s && String(s).trim()) return String(s).trim();
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }
  return DEV_FALLBACK_SECRET;
}

function getExpiresIn() {
  const raw = process.env.JWT_EXPIRES_IN;
  if (raw && String(raw).trim()) return String(raw).trim();
  return "7d";
}

/**
 * Create a signed admin session token after OTP succeeds.
 * Payload holds role and the admin phone (10 digits).
 */
function signAdminAccessToken(phone10) {
  const phone = String(phone10 || "").replace(/\D/g, "").slice(-10);
  return jwt.sign({ role: "ADMIN", sub: `admin:${phone}`, phone }, getJwtSecret(), {
    expiresIn: getExpiresIn(),
  });
}

/**
 * Create a signed partner session token after OTP succeeds.
 * Payload ties the token to one restaurant row.
 */
function signPartnerAccessToken(restaurantId, phone10) {
  const rid = String(restaurantId || "").trim();
  const phone = String(phone10 || "").replace(/\D/g, "").slice(-10);
  return jwt.sign({ role: "PARTNER", sub: rid, restaurantId: rid, phone }, getJwtSecret(), {
    expiresIn: getExpiresIn(),
  });
}

function readBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)/i.exec(h.trim());
  return m ? m[1] : null;
}

/** True when Authorization bears a valid admin JWT (no response written). */
function adminBearerIsValid(req) {
  const token = readBearerToken(req);
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    return decoded.role === "ADMIN";
  } catch {
    return false;
  }
}

function attachAdmin(req, res, token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.role !== "ADMIN") {
      res.status(403).json({ error: "Admin access only" });
      return false;
    }
    req.auth = decoded;
    return true;
  } catch {
    res.status(401).json({ error: "Session expired or invalid. Please sign in again." });
    return false;
  }
}

function attachPartner(req, res, token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.role !== "PARTNER" || !decoded.restaurantId) {
      res.status(403).json({ error: "Partner access only" });
      return false;
    }
    req.partner = {
      restaurantId: String(decoded.restaurantId),
      phone: decoded.phone ? String(decoded.phone) : "",
    };
    return true;
  } catch {
    res.status(401).json({ error: "Session expired or invalid. Please sign in again." });
    return false;
  }
}

/** Blocks the request unless a valid admin token is present. */
function requireAdmin(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  if (!attachAdmin(req, res, token)) return;
  next();
}

/** Blocks the request unless a valid partner token is present. */
function requirePartner(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Partner sign in required" });
    return;
  }
  if (!attachPartner(req, res, token)) return;
  next();
}

/**
 * Ensures the restaurant id on the request matches the restaurant embedded in the partner token.
 * Call after requirePartner inside route handlers.
 */
function assertPartnerOwnsRestaurant(req, res, restaurantId) {
  const id = String(restaurantId || "").trim();
  if (!id) {
    res.status(400).json({ error: "restaurantId is required" });
    return false;
  }
  if (!req.partner || id !== req.partner.restaurantId) {
    res.status(403).json({ error: "This action is not allowed for your outlet" });
    return false;
  }
  return true;
}

module.exports = {
  signAdminAccessToken,
  signPartnerAccessToken,
  requireAdmin,
  requirePartner,
  assertPartnerOwnsRestaurant,
  readBearerToken,
  adminBearerIsValid,
};
