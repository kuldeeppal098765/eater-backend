/**
 * Removes ALL rows from app tables (live / production prep).
 * Schema & migrations unchanged — only data deleted.
 *
 * Run: npm run db:clear
 * From repo root: cd eater-backend && npm run db:clear
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  console.log("Clearing all data (FK-safe order)…");

  await prisma.$transaction(async (tx) => {
    await tx.orderItem.deleteMany();
    await tx.order.deleteMany();
    await tx.notification.deleteMany();
    await tx.menuItem.deleteMany();
    await tx.coupon.deleteMany();
    await tx.address.deleteMany();
    await tx.restaurant.deleteMany();
    await tx.rider.deleteMany();
    await tx.user.deleteMany();
  });

  console.log("Done. Users, restaurants, menus, orders, riders, coupons, notifications, addresses — all empty.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
