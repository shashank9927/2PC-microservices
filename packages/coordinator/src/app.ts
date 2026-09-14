import express from "express";
import { z } from "zod";
import { PrismaClient } from "./generated/client";
import type { CoordinatorConfig } from "./config";
import {
  TransactionCoordinator,
  IdempotencyMismatchError,
  IdempotencyConflictError,
} from "./transactionCoordinator";

const transferSchema = z.object({
  fromAccountId: z.string().min(1).max(100).default("alice"),
  toAccountId: z.string().min(1).max(100).default("bob"),
  amountCents: z.number().int().positive(),
  forcePrepareFailureAt: z.enum(["bank-a", "bank-b"]).optional(),
  simulateCrashAfterDecision: z.boolean().optional().default(false),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function createCoordinatorApp(prisma: PrismaClient, config: CoordinatorConfig) {
  const coordinator = new TransactionCoordinator(prisma, config);
  const app = express();
  app.use(express.json());

  app.get("/health", (_request, response) => response.json({ ok: true }));

  app.post("/transfers", async (request, response) => {
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    const rawKey = request.get("Idempotency-Key") ?? request.get("X-Idempotency-Key");
    const idempotencyKey = typeof rawKey === "string" && rawKey.trim().length > 0 ? rawKey.trim() : undefined;
    try {
      const result = await coordinator.startTransfer({ ...parsed.data, idempotencyKey });
      // 201 = committed & complete, 422 = aborted (business failure), 202 = decided but phase 2 pending
      const status = !result.complete ? 202 : result.decision === "COMMIT" ? 201 : 422;
      return response.status(status).json(result);
    } catch (error) {
      if (error instanceof IdempotencyMismatchError) {
        return response.status(422).json({ error: error.message });
      }
      if (error instanceof IdempotencyConflictError) {
        return response.status(409).json({ error: error.message });
      }
      return response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/transactions", async (_request, response) => {
    response.json(await coordinator.list());
  });

  app.post("/transactions/:transactionId/resolve", async (request, response) => {
    try {
      const result = await coordinator.resolve(request.params.transactionId);
      return response.status(result.complete ? 200 : 202).json(result);
    } catch (error) {
      return response.status(409).json({ error: errorMessage(error) });
    }
  });

  app.post("/transactions/:transactionId/abort", async (request, response) => {
    try {
      const result = await coordinator.abortUndecided(request.params.transactionId);
      return response.status(result.complete ? 200 : 202).json(result);
    } catch (error) {
      return response.status(409).json({ error: errorMessage(error) });
    }
  });

  app.post("/recovery/run", async (_request, response) => {
    try {
      return response.json({ recovered: await coordinator.recover() });
    } catch (error) {
      return response.status(503).json({ error: errorMessage(error) });
    }
  });

  app.post("/reaper/run", async (request, response) => {
    try {
      const olderThanMs =
        typeof request.query.olderThanMs === "string"
          ? Number(request.query.olderThanMs)
          : typeof request.body?.olderThanMs === "number"
            ? request.body.olderThanMs
            : config.stuckTransactionTimeoutMs;
      const reaped = await coordinator.reapStuckTransactions(
        Number.isFinite(olderThanMs) ? olderThanMs : config.stuckTransactionTimeoutMs,
      );
      return response.json({ reapedCount: reaped.length, transactions: reaped });
    } catch (error) {
      return response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: errorMessage(error) });
  });
  return { app, coordinator };
}
