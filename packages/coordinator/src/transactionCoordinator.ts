import { randomUUID } from "node:crypto";
import { Decision, Prisma, PrismaClient } from "./generated/client";
import type { CoordinatorConfig } from "./config";
import {
  configuredParticipants,
  prepareParticipant,
  resolveParticipant,
  type ParticipantName,
  type ParticipantOperation,
  type ParticipantProgress,
} from "./participantClient";
import { ParticipantRegistry } from "./participantRegistry";

export class IdempotencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyMismatchError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export type TransferRequest = {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  idempotencyKey?: string;
  forcePrepareFailureAt?: ParticipantName;
  simulateCrashAfterDecision?: boolean;
};

export type Resolution = {
  transactionId: string;
  decision: "COMMIT" | "ABORT";
  complete: boolean;
  errors: string[];
};

const settling = new Set<string>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asJson(participants: ParticipantProgress[]): Prisma.InputJsonValue {
  return participants as unknown as Prisma.InputJsonValue;
}

function parseParticipants(value: Prisma.JsonValue): ParticipantProgress[] {
  if (!Array.isArray(value)) throw new Error("Decision-log participants are malformed");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Decision-log participant is malformed");
    }
    const participant = item as Record<string, unknown>;
    if (
      typeof participant.name !== "string" ||
      !participant.name ||
      typeof participant.url !== "string" ||
      typeof participant.phase !== "string"
    ) {
      throw new Error("Decision-log participant has invalid fields");
    }
    return {
      name: participant.name,
      url: participant.url,
      ...(typeof participant.accountId === "string" ? { accountId: participant.accountId } : {}),
      phase: participant.phase as ParticipantProgress["phase"],
      ...(typeof participant.lastError === "string" ? { lastError: participant.lastError } : {}),
      ...(participant.metadata && typeof participant.metadata === "object"
        ? { metadata: participant.metadata as Record<string, unknown> }
        : {}),
    };
  });
}

export class TransactionCoordinator {
  public readonly registry: ParticipantRegistry;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: CoordinatorConfig,
    registry?: ParticipantRegistry,
  ) {
    this.registry = registry ?? new ParticipantRegistry();
    if (this.registry.list().length === 0) {
      this.registry.register({
        name: "bank-a",
        url: this.config.bankAUrl,
        type: "bank",
        currency: "USD",
        accountIds: [this.config.bankAAccountId],
      });
      this.registry.register({
        name: "bank-b",
        url: this.config.bankBUrl,
        type: "bank",
        currency: "EUR",
        accountIds: [this.config.bankBAccountId],
      });
    }
  }

  private async handleExistingIdempotentTransfer(
    existing: {
      id: string;
      fromAccountId: string;
      toAccountId: string;
      amountCents: number;
      status: string;
      decision: Decision | null;
      resolutionNote: string | null;
    },
    input: TransferRequest,
  ): Promise<Resolution> {
    if (
      existing.fromAccountId !== input.fromAccountId ||
      existing.toAccountId !== input.toAccountId ||
      existing.amountCents !== input.amountCents
    ) {
      throw new IdempotencyMismatchError(
        "Idempotency key was previously used with different transfer parameters",
      );
    }

    if (existing.status === "COMPLETED" && existing.decision) {
      return {
        transactionId: existing.id,
        decision: existing.decision,
        complete: true,
        errors: existing.resolutionNote ? [existing.resolutionNote] : [],
      };
    }

    if (existing.decision) {
      return this.resolve(existing.id);
    }

    throw new IdempotencyConflictError(
      "A transaction with this idempotency key is currently in progress",
    );
  }

  async startTransfer(input: TransferRequest): Promise<Resolution> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.distributedTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return this.handleExistingIdempotentTransfer(existing, input);
      }
    }

    const transactionId = randomUUID();

    const fromBank = this.registry.findBankForAccount(input.fromAccountId) ?? {
      name: "bank-a",
      url: this.config.bankAUrl,
      type: "bank" as const,
      currency: "USD",
      accountIds: [input.fromAccountId],
    };
    const toBank = this.registry.findBankForAccount(input.toAccountId) ?? {
      name: "bank-b",
      url: this.config.bankBUrl,
      type: "bank" as const,
      currency: "EUR",
      accountIds: [input.toAccountId],
    };

    const fromCurrency = fromBank.currency ?? "USD";
    const toCurrency = toBank.currency ?? "EUR";
    const isCrossCurrency = fromCurrency !== toCurrency;
    const ratesService = isCrossCurrency ? this.registry.getRatesService() : undefined;

    const participants: ParticipantProgress[] = [
      { name: fromBank.name, url: fromBank.url, accountId: input.fromAccountId, phase: "pending" },
    ];
    if (ratesService) {
      participants.push({ name: ratesService.name, url: ratesService.url, phase: "pending" });
    }
    participants.push({ name: toBank.name, url: toBank.url, accountId: input.toAccountId, phase: "pending" });

    try {
      await this.prisma.distributedTransaction.create({
        data: {
          id: transactionId,
          idempotencyKey: input.idempotencyKey,
          participants: asJson(participants),
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          amountCents: input.amountCents,
        },
      });
    } catch (error) {
      if (
        input.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await this.prisma.distributedTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          return this.handleExistingIdempotentTransfer(existing, input);
        }
      }
      throw error;
    }

    let prepareError: string | undefined;
    let targetCreditAmountCents = input.amountCents;

    for (let index = 0; index < participants.length; index += 1) {
      const participant = participants[index];
      if (!participant) continue;

      let operation: ParticipantOperation;
      if (ratesService && participant.name === ratesService.name) {
        operation = {
          kind: "exchange",
          fromCurrency,
          toCurrency,
          fromAmountCents: input.amountCents,
        };
      } else if (participant.accountId === input.fromAccountId) {
        operation = {
          kind: "debit",
          accountId: input.fromAccountId,
          amountCents: input.amountCents,
        };
      } else {
        operation = {
          kind: "credit",
          accountId: input.toAccountId,
          amountCents: targetCreditAmountCents,
        };
      }

      try {
        const prepareResult = await prepareParticipant(
          participant,
          transactionId,
          operation,
          input.forcePrepareFailureAt === participant.name,
          this.config.participantTimeoutMs,
        );

        if (ratesService && participant.name === ratesService.name && prepareResult) {
          if (typeof prepareResult.toAmountCents === "number") {
            targetCreditAmountCents = prepareResult.toAmountCents;
          }
          participant.metadata = {
            rate: prepareResult.rate,
            toAmountCents: targetCreditAmountCents,
          };
        }

        participants[index] = { ...participant, phase: "prepared" };
        await this.storeParticipants(transactionId, participants);
      } catch (error) {
        prepareError = errorMessage(error);
        participants[index] = { ...participant, phase: "prepare_failed", lastError: prepareError };
        for (let skipped = index + 1; skipped < participants.length; skipped += 1) {
          const remaining = participants[skipped];
          if (remaining) participants[skipped] = { ...remaining, phase: "skipped" };
        }
        await this.prisma.distributedTransaction.update({
          where: { id: transactionId },
          data: { participants: asJson(participants), prepareError },
        });
        break;
      }
    }

    const decision: Decision = prepareError ? Decision.ABORT : Decision.COMMIT;
    // The irreversible decision is committed to PostgreSQL before any phase-2
    // request. Recovery only replays this durable fact; it never re-decides.
    await this.prisma.distributedTransaction.update({
      where: { id: transactionId },
      data: { decision, status: "DECIDED" },
    });

    if (input.simulateCrashAfterDecision) {
      console.error(`[coordinator] injected crash after durable ${decision} for ${transactionId}`);
      // Docker's on-failure policy restarts the service; startup recovery then
      // observes the recorded decision and performs phase 2.
      setTimeout(() => process.exit(86), 25).unref();
      return { transactionId, decision, complete: false, errors: ["Crash injected after durable decision"] };
    }
    return this.resolve(transactionId);
  }

  async resolve(transactionId: string): Promise<Resolution> {
    if (settling.has(transactionId)) {
      const existing = await this.prisma.distributedTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (!existing.decision) throw new Error("A transaction without a decision cannot be resolved safely");
      return { transactionId, decision: existing.decision, complete: existing.status === "COMPLETED", errors: ["Resolution already in progress"] };
    }
    settling.add(transactionId);
    try {
      const transaction = await this.prisma.distributedTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (!transaction.decision) throw new Error("A transaction without a decision cannot be resolved safely");
      if (transaction.status === "COMPLETED") {
        return { transactionId, decision: transaction.decision, complete: true, errors: [] };
      }

      const participants = parseParticipants(transaction.participants);
      await this.prisma.distributedTransaction.update({
        where: { id: transactionId },
        data: { status: "COMPLETING", resolutionNote: null },
      });

      const errors: string[] = [];
      for (let index = 0; index < participants.length; index += 1) {
        const participant = participants[index];
        if (!participant) continue;
        // Only send phase-2 to participants that actually reached the prepared state.
        // Participants that failed to prepare (prepare_failed) or were skipped never
        // hold a prepared transaction, so sending rollback would be a no-op at best
        // and would overwrite the diagnostic phase in the audit log at worst.
        if (participant.phase !== "prepared" && participant.phase !== "resolution_failed") {
          continue;
        }
        try {
          await resolveParticipant(participant, transactionId, transaction.decision, this.config.participantTimeoutMs);
          const { lastError: _discardedError, ...participantWithoutError } = participant;
          participants[index] = {
            ...participantWithoutError,
            phase: transaction.decision === Decision.COMMIT ? "committed" : "rolled_back",
          };
          await this.storeParticipants(transactionId, participants);
        } catch (error) {
          const detail = errorMessage(error);
          errors.push(detail);
          participants[index] = { ...participant, phase: "resolution_failed", lastError: detail };
          await this.storeParticipants(transactionId, participants);
        }
      }

      if (errors.length > 0) {
        await this.prisma.distributedTransaction.update({
          where: { id: transactionId },
          data: { status: "DECIDED", resolutionNote: errors.join(" | ") },
        });
        return { transactionId, decision: transaction.decision, complete: false, errors };
      }
      await this.prisma.distributedTransaction.update({
        where: { id: transactionId },
        data: { status: "COMPLETED", resolutionNote: null },
      });
      return { transactionId, decision: transaction.decision, complete: true, errors: [] };
    } finally {
      settling.delete(transactionId);
    }
  }

  async abortUndecided(transactionId: string): Promise<Resolution> {
    const transaction = await this.prisma.distributedTransaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (transaction.decision && transaction.decision !== Decision.ABORT) {
      throw new Error("Cannot change a durable COMMIT decision to ABORT");
    }
    if (!transaction.decision) {
      await this.prisma.distributedTransaction.update({
        where: { id: transactionId },
        data: { decision: Decision.ABORT, status: "DECIDED", resolutionNote: "Operator selected abort for an undecided transaction" },
      });
    }
    return this.resolve(transactionId);
  }

  async recover(): Promise<Resolution[]> {
    const transactions = await this.prisma.distributedTransaction.findMany({
      where: { decision: { not: null }, status: { not: "COMPLETED" } },
      orderBy: { createdAt: "asc" },
    });
    const results: Resolution[] = [];
    for (const transaction of transactions) {
      results.push(await this.resolve(transaction.id));
    }
    return results;
  }

  async reapStuckTransactions(olderThanMs: number = 60_000): Promise<Resolution[]> {
    const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
    const stuck = await this.prisma.distributedTransaction.findMany({
      where: {
        status: "PREPARING",
        decision: null,
        createdAt: { lte: cutoff },
      },
      orderBy: { createdAt: "asc" },
    });

    const results: Resolution[] = [];
    for (const tx of stuck) {
      console.warn(
        `[coordinator] reaper aborting stuck transaction ${tx.id} (created at ${tx.createdAt.toISOString()})`,
      );
      await this.prisma.distributedTransaction.update({
        where: { id: tx.id },
        data: {
          decision: Decision.ABORT,
          status: "DECIDED",
          resolutionNote: "Automated reaper aborted stuck undecided transaction",
        },
      });
      results.push(await this.resolve(tx.id));
    }
    return results;
  }

  async list() {
    return this.prisma.distributedTransaction.findMany({ orderBy: { createdAt: "desc" } });
  }

  private async storeParticipants(transactionId: string, participants: ParticipantProgress[]): Promise<void> {
    await this.prisma.distributedTransaction.update({
      where: { id: transactionId },
      data: { participants: asJson(participants) },
    });
  }
}
