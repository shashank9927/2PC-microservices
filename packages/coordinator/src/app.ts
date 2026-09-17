import express from "express";
import { z } from "zod";
import { PrismaClient } from "./generated/client";
import type { CoordinatorConfig } from "./config";
import {
  TransactionCoordinator,
  IdempotencyMismatchError,
  IdempotencyConflictError,
} from "./transactionCoordinator";
import { globalChaosMonkey } from "./chaosMonkey";

const transferSchema = z
  .object({
    fromAccountId: z.string().min(1).max(100).default("alice"),
    toAccountId: z.string().min(1).max(100).default("bob"),
    amountCents: z.number().int(),
    readOnlyParticipants: z.array(z.string()).optional(),
    forcePrepareFailureAt: z.string().optional(),
    simulateCrashAfterDecision: z.boolean().optional().default(false),
  })
  .refine(
    (data) =>
      data.readOnlyParticipants && data.readOnlyParticipants.length > 0
        ? data.amountCents >= 0
        : data.amountCents > 0,
    { message: "amountCents must be positive unless readOnlyParticipants is specified", path: ["amountCents"] },
  );

const chaosRuleSchema = z.object({
  id: z.string().optional(),
  target: z.string().min(1),
  path: z.string().optional(),
  action: z.enum(["drop", "delay", "partition", "error"]),
  delayMs: z.number().int().nonnegative().optional(),
  times: z.number().int().positive().optional(),
});

const registerParticipantSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  type: z.enum(["bank", "exchange-rate", "custom"]).default("bank"),
  currency: z.string().min(1).max(10).optional(),
  accountIds: z.array(z.string()).optional(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function createCoordinatorApp(prisma: PrismaClient, config: CoordinatorConfig) {
  const coordinator = new TransactionCoordinator(prisma, config);
  const app = express();
  app.use(express.json());

  app.get("/health", (_request, response) => response.json({ ok: true }));

  app.post("/participants/register", (request, response) => {
    const parsed = registerParticipantSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    try {
      coordinator.registry.register(parsed.data);
      return response.status(201).json({ ok: true, participant: coordinator.registry.get(parsed.data.name) });
    } catch (error) {
      return response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/participants", (_request, response) => {
    response.json({ participants: coordinator.registry.list() });
  });

  app.delete("/participants/:name", (request, response) => {
    const removed = coordinator.registry.unregister(request.params.name);
    if (!removed) return response.status(404).json({ error: "Participant not found" });
    return response.json({ ok: true });
  });

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

  app.post("/chaos/rules", (request, response) => {
    const parsed = chaosRuleSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    try {
      const rule = globalChaosMonkey.addRule(parsed.data);
      return response.status(201).json({ ok: true, rule });
    } catch (error) {
      return response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/chaos/rules", (_request, response) => {
    return response.json({ rules: globalChaosMonkey.getRules() });
  });

  app.delete("/chaos/rules/:id", (request, response) => {
    const removed = globalChaosMonkey.removeRule(request.params.id);
    if (!removed) return response.status(404).json({ error: "Rule not found" });
    return response.json({ ok: true });
  });

  app.post("/chaos/reset", (_request, response) => {
    globalChaosMonkey.clear();
    return response.json({ ok: true });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: errorMessage(error) });
  });
  return { app, coordinator };
}
