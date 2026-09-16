import { createRatesApp } from "./app";

const port = Number(process.env.PORT ?? 3003);
const serviceName = process.env.SERVICE_NAME ?? "rates-service";
const coordinatorUrl = process.env.COORDINATOR_URL;

const { app } = createRatesApp({ serviceName });

const server = app.listen(port, async () => {
  console.log(`[${serviceName}] listening on port ${port}`);

  if (coordinatorUrl) {
    try {
      const myUrl = process.env.MY_URL ?? `http://localhost:${port}`;
      const res = await fetch(`${coordinatorUrl.replace(/\/$/, "")}/participants/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: serviceName,
          url: myUrl,
          type: "exchange-rate",
        }),
      });
      if (res.ok) {
        console.log(`[${serviceName}] registered with coordinator at ${coordinatorUrl}`);
      } else {
        console.warn(`[${serviceName}] registration returned ${res.status}`);
      }
    } catch (err) {
      console.warn(`[${serviceName}] auto-registration with coordinator failed:`, err);
    }
  }
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
