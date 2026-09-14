import { PrismaClient } from "./generated/client";
import { createCoordinatorApp } from "./app";
import { loadConfig } from "./config";

async function main() {
  const config = loadConfig();
  const prisma = new PrismaClient();
  await prisma.$connect();
  const { app, coordinator } = createCoordinatorApp(prisma, config);
  const server = app.listen(config.port, () => {
    console.log(`[coordinator] listening on port ${config.port}`);
  });

  const recover = async () => {
    try {
      const results = await coordinator.recover();
      if (results.length > 0) console.log("[coordinator] recovery results", results);
    } catch (error) {
      console.error("[coordinator] recovery attempt failed", error);
    }
  };
  await recover();
  const recoveryTimer = setInterval(() => void recover(), 10_000);
  recoveryTimer.unref();

  const reap = async () => {
    try {
      const results = await coordinator.reapStuckTransactions(config.stuckTransactionTimeoutMs);
      if (results.length > 0) console.log("[coordinator] reaper reaped stuck transactions", results);
    } catch (error) {
      console.error("[coordinator] reaper sweep failed", error);
    }
  };
  await reap();
  const reaperTimer = setInterval(() => void reap(), config.reaperIntervalMs);
  reaperTimer.unref();

  const shutdown = () => {
    clearInterval(recoveryTimer);
    clearInterval(reaperTimer);
    server.close(() => void prisma.$disconnect().finally(() => process.exit(0)));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Coordinator failed to start", error);
  process.exit(1);
});
