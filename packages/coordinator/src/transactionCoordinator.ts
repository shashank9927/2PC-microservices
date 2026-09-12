import { randomUUID } from "node:crypto";
import { Decision, Prisma, PrismaClient } from "./generated/client";
import type { CoordinatorConfig } from "./config";
import {
  configuredParticipants,
  prepareParticipant,
  resolveParticipant,
  type ParticipantName,
  type ParticipantProgress,
} from "./participantClient";

export type TransferRequest = {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
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
      (participant.name !== "bank-a" && participant.name !== "bank-b") ||
      typeof participant.url !== "string" ||
      typeof participant.accountId !== "string" ||
      typeof participant.phase !== "string"
    ) {
      throw new Error("Decision-log participant has invalid fields");
    }
    return {
      name: participant.name,
      url: participant.url,
      accountId: participant.accountId,
      phase: participant.phase as ParticipantProgress["phase"],
      ...(typeof participant.lastError === "string" ? { lastError: participant.lastError } : {}),
    };
  });
}

export class TransactionCoordinator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: CoordinatorConfig,
  ) {}

  async startTransfer(input: TransferRequest): Promise<Resolution> {
    const transactionId = randomUUID();
    const participants = configuredParticipants(this.config);
    await this.prisma.distributedTransaction.create({
      data: {
        id: transactionId,
        participants: asJson(participants),
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amountCents: input.amountCents,
      },
    });

    let prepareError: string | undefined;
    for (let index = 0; index < participants.length; index += 1) {
      const participant = participants[index];
      if (!participant) continue;
      // Derive operation direction from which account this participant owns.
      // This supports both Alice→Bob (bank-a debits) and Bob→Alice (bank-b debits).
      const isDebitor = participant.accountId === input.fromAccountId;
      const operation = isDebitor
        ? { kind: "debit" as const, accountId: input.fromAccountId, amountCents: input.amountCents }
        : { kind: "credit" as const, accountId: input.toAccountId, amountCents: input.amountCents };
      try {
        await prepareParticipant(
          participant,
          transactionId,
          operation,
          input.forcePrepareFailureAt === participant.name,
          this.config.participantTimeoutMs,
        );
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
