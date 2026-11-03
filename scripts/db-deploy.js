const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
  await prisma.$disconnect();

  if (!rows[0].present) {
    execFileSync(
      process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "resolve", "--applied", "20261103000000_baseline_existing_database"],
      { stdio: "inherit" },
    );
  }

  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
    stdio: "inherit",
  });
}

main().catch(async () => {
  await prisma.$disconnect().catch(() => {});
  console.error("Database migration step failed.");
  process.exitCode = 1;
});
