import type { CoordinatorConfig } from "./config";
import { globalChaosMonkey, type ChaosMonkey } from "./chaosMonkey";

export type ParticipantName = string;
export type ParticipantProgress = {
  name: ParticipantName;
  url: string;
  accountId?: string;
  phase: "pending" | "prepared" | "read_only" | "prepare_failed" | "skipped" | "committed" | "rolled_back" | "resolution_failed";
  lastError?: string;
  metadata?: Record<string, unknown>;
};

export type ParticipantOperation =
  | {
      kind: "debit" | "credit" | "read_only";
      accountId: string;
      amountCents?: number;
    }
  | {
      kind: "exchange";
      fromCurrency: string;
      toCurrency: string;
      fromAmountCents?: number;
      amountCents?: number;
    };

export function configuredParticipants(config: CoordinatorConfig): ParticipantProgress[] {
  return [
    { name: "bank-a", url: config.bankAUrl, accountId: config.bankAAccountId, phase: "pending" },
    { name: "bank-b", url: config.bankBUrl, accountId: config.bankBAccountId, phase: "pending" },
  ];
}

async function post(
  participant: ParticipantProgress,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  chaosMonkey: ChaosMonkey = globalChaosMonkey,
): Promise<Record<string, unknown> | undefined> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    await chaosMonkey.intercept(participant.name, path, signal);
    response = await fetch(`${participant.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${participant.name} ${path} did not respond: ${detail}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${participant.name} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function prepareParticipant(
  participant: ParticipantProgress,
  transactionId: string,
  operation: ParticipantOperation,
  failBeforePrepare: boolean,
  timeoutMs: number,
  chaosMonkey?: ChaosMonkey,
): Promise<Record<string, unknown> | undefined> {
  return post(participant, "/prepare", { transactionId, operation, failBeforePrepare }, timeoutMs, chaosMonkey);
}

export async function resolveParticipant(
  participant: ParticipantProgress,
  transactionId: string,
  decision: "COMMIT" | "ABORT",
  timeoutMs: number,
  chaosMonkey?: ChaosMonkey,
): Promise<void> {
  await post(participant, decision === "COMMIT" ? "/commit" : "/rollback", { transactionId }, timeoutMs, chaosMonkey);
}
