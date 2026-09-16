import express, { type Request, type Response } from "express";
import { z } from "zod";
import { RatesService } from "./ratesService";

const transactionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/);

const prepareSchema = z.object({
  transactionId: transactionIdSchema,
  operation: z.object({
    kind: z.literal("exchange").default("exchange"),
    fromCurrency: z.string().min(1).max(10).default("USD"),
    toCurrency: z.string().min(1).max(10).default("EUR"),
    fromAmountCents: z.number().int().positive().optional(),
    amountCents: z.number().int().positive().optional(),
  }),
  failBeforePrepare: z.boolean().optional().default(false),
});

const resolveSchema = z.object({ transactionId: transactionIdSchema });

const rateUpdateSchema = z.object({
  fromCurrency: z.string().min(1).max(10),
  toCurrency: z.string().min(1).max(10),
  rate: z.number().positive(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export interface RatesAppOptions {
  serviceName?: string;
  ratesService?: RatesService;
}

export function createRatesApp(options: RatesAppOptions = {}) {
  const serviceName = options.serviceName ?? "rates-service";
  const ratesService = options.ratesService ?? new RatesService();

  const app = express();
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ name: serviceName, ok: true });
  });

  app.get("/rates", (_request, response) => {
    response.json({ rates: ratesService.getAllRates() });
  });

  app.post("/rates", (request, response) => {
    const parsed = rateUpdateSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    try {
      ratesService.setRate(parsed.data.fromCurrency, parsed.data.toCurrency, parsed.data.rate);
      return response.json({ ok: true, rates: ratesService.getAllRates() });
    } catch (error) {
      return response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/prepared", (_request, response) => {
    response.json({ participant: serviceName, prepared: ratesService.getPreparedList() });
  });

  app.post("/prepare", (request: Request, response: Response) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    if (parsed.data.failBeforePrepare) {
      return response.status(503).json({ error: "Injected prepare failure at rate service" });
    }

    try {
      const amount = parsed.data.operation.fromAmountCents ?? parsed.data.operation.amountCents;
      if (!amount) throw new Error("amountCents or fromAmountCents must be provided");

      const result = ratesService.prepareQuote(
        parsed.data.transactionId,
        parsed.data.operation.fromCurrency,
        parsed.data.operation.toCurrency,
        amount,
      );

      return response.status(200).json({
        participant: serviceName,
        transactionId: parsed.data.transactionId,
        state: result.state,
        rate: result.rate,
        toAmountCents: result.toAmountCents,
      });
    } catch (error) {
      return response.status(409).json({ participant: serviceName, error: errorMessage(error) });
    }
  });

  async function resolve(decision: "COMMIT" | "ABORT", request: Request, response: Response) {
    const parsed = resolveSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    try {
      const state = ratesService.resolveQuote(parsed.data.transactionId, decision);
      return response.json({ participant: serviceName, transactionId: parsed.data.transactionId, state });
    } catch (error) {
      return response.status(503).json({ participant: serviceName, error: errorMessage(error) });
    }
  }

  app.post("/commit", (request, response) => resolve("COMMIT", request, response));
  app.post("/rollback", (request, response) => resolve("ABORT", request, response));

  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    response.status(500).json({ error: errorMessage(error) });
  });

  return { app, ratesService };
}
