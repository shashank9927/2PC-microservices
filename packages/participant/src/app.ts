import express, { type Request, type Response } from "express";
import { Pool } from "pg";
import { z } from "zod";
import { PrismaClient } from "./generated/client";
import type { ParticipantConfig } from "./config";
import { prepareOperation, resolvePreparedTransaction } from "./twoPhaseCommit";

const transactionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/);
const prepareSchema = z.object({
  transactionId: transactionIdSchema,
  operation: z.object({
    kind: z.enum(["debit", "credit", "read_only"]),
    accountId: z.string().min(1).max(100),
    amountCents: z.number().int().nonnegative().optional().default(0),
  }),
  // Used only by the demo to make the coordinator take the abort path.
  failBeforePrepare: z.boolean().optional().default(false),
});
const resolveSchema = z.object({ transactionId: transactionIdSchema });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function createParticipantApp(config: ParticipantConfig) {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const pool = new Pool({ connectionString: config.databaseUrl });
  await prisma.$connect();
  await prisma.account.upsert({
    where: { id: config.initialAccountId },
    create: { id: config.initialAccountId, balanceCents: config.initialBalanceCents },
    update: {},
  });

  const app = express();
  app.use(express.json());

  const currency = config.currency ?? (config.name === "bank-b" ? "EUR" : "USD");

  app.get("/health", async (_request, response) => {
    await pool.query("SELECT 1");
    response.json({ name: config.name, currency, ok: true });
  });

  app.get("/accounts", async (_request, response) => {
    const accounts = await prisma.account.findMany({ orderBy: { id: "asc" } });
    response.json({ participant: config.name, currency, accounts });
  });

  app.get("/prepared", async (_request, response) => {
    const prepared = await pool.query(
      "SELECT gid, prepared, owner, database FROM pg_prepared_xacts WHERE database = current_database() ORDER BY prepared",
    );
    response.json({ participant: config.name, prepared: prepared.rows });
  });

  app.post("/prepare", async (request: Request, response: Response) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    if (parsed.data.failBeforePrepare) {
      return response.status(503).json({ error: "Injected prepare failure" });
    }

    try {
      const state = await prepareOperation(pool, parsed.data.transactionId, parsed.data.operation);
      const vote = state === "read_only" ? "VOTE_READ_ONLY" : "VOTE_COMMIT";
      return response.status(200).json({
        participant: config.name,
        state,
        vote,
        transactionId: parsed.data.transactionId,
      });
    } catch (error) {
      return response.status(409).json({ participant: config.name, error: errorMessage(error) });
    }
  });

  async function resolve(decision: "COMMIT" | "ABORT", request: Request, response: Response) {
    const parsed = resolveSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues });
    try {
      const state = await resolvePreparedTransaction(pool, parsed.data.transactionId, decision);
      return response.json({ participant: config.name, transactionId: parsed.data.transactionId, state });
    } catch (error) {
      return response.status(503).json({ participant: config.name, error: errorMessage(error) });
    }
  }

  app.post("/commit", (request, response) => resolve("COMMIT", request, response));
  app.post("/rollback", (request, response) => resolve("ABORT", request, response));

  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    response.status(500).json({ error: errorMessage(error) });
  });

  async function close() {
    await Promise.all([prisma.$disconnect(), pool.end()]);
  }
  return { app, close };
}
