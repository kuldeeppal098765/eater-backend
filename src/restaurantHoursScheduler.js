/**
 * IST-based automatic outlet online/offline from openingTime / closingTime.
 */

const cron = require("node-cron");

const TIME_24H = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseTimeToMinutes(timeString) {
  const s = String(timeString || "").trim();
  if (!TIME_24H.test(s)) return null;
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** Current minutes from midnight in Asia/Kolkata. */
function getCurrentMinutesIst() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return hour * 60 + minute;
}

/**
 * @param {number} currentMinutes - minutes from midnight IST
 * @param {number} openMinutes
 * @param {number} closeMinutes
 */
function isWithinServingWindow(currentMinutes, openMinutes, closeMinutes) {
  if (closeMinutes > openMinutes) {
    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  }
  if (closeMinutes < openMinutes) {
    return currentMinutes >= openMinutes || currentMinutes < closeMinutes;
  }
  return false;
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 */
const customerListedOutletWhere = { approvalStatus: "APPROVED", isActive: true };

/**
 * Count approved, active outlets by live flag (after scheduler sync).
 * @param {import('@prisma/client').PrismaClient} prisma
 */
async function logSynchronizedOutletAvailabilityCounts(prisma) {
  const outletOnlineCount = await prisma.restaurant.count({
    where: { ...customerListedOutletWhere, isOnline: true },
  });
  const outletOfflineCount = await prisma.restaurant.count({
    where: { ...customerListedOutletWhere, isOnline: false },
  });
  const dateTimeStamp = new Date().toISOString();
  console.log(
    `${dateTimeStamp} info: Synchronized check complete. ${outletOnlineCount} online, ${outletOfflineCount} offline outlets verified...`,
  );
  return { outletOnlineCount, outletOfflineCount };
}

async function runRestaurantAutoOnlineWindow(prisma) {
  const list = await prisma.restaurant.findMany({
    where: { isAutoToggleEnabled: true },
    select: {
      id: true,
      openingTime: true,
      closingTime: true,
      isOnline: true,
    },
  });
  const nowM = getCurrentMinutesIst();
  for (const row of list) {
    const openM = parseTimeToMinutes(row.openingTime);
    const closeM = parseTimeToMinutes(row.closingTime);
    if (openM == null || closeM == null) continue;
    const nextOnline = isWithinServingWindow(nowM, openM, closeM);
    if (row.isOnline !== nextOnline) {
      await prisma.restaurant.update({
        where: { id: row.id },
        data: { isOnline: nextOnline },
      });
    }
  }
  await logSynchronizedOutletAvailabilityCounts(prisma);
}

/**
 * Start cron: every minute in server local time (job uses IST for logic).
 * @param {import('@prisma/client').PrismaClient} prisma
 */
function startRestaurantHoursScheduler(prisma) {
  cron.schedule("* * * * *", () => {
    runRestaurantAutoOnlineWindow(prisma).catch((err) => {
      console.error("restaurantHoursScheduler:", err?.message || err);
    });
  });
  console.log("✅ Restaurant hours scheduler (IST) — every 1 minute");
}

module.exports = {
  startRestaurantHoursScheduler,
  runRestaurantAutoOnlineWindow,
  logSynchronizedOutletAvailabilityCounts,
  parseTimeToMinutes,
  getCurrentMinutesIst,
  isWithinServingWindow,
};
