import { createParticipantApp } from "./app";
import { loadConfig } from "./config";

async function main() {
  const config = loadConfig();
  const { app, close } = await createParticipantApp(config);
  const server = app.listen(config.port, () => {
    console.log(`[${config.name}] listening on port ${config.port}`);
  });

  const shutdown = () => {
    server.close(() => void close().finally(() => process.exit(0)));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Participant failed to start", error);
  process.exit(1);
});
