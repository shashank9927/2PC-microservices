export interface CoordinatorConfig {
  databaseUrl: string;
  port: number;
  bankAUrl: string;
  bankBUrl: string;
  bankAAccountId: string;
  bankBAccountId: string;
  participantTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value.replace(/\/$/, "");
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(): CoordinatorConfig {
  return {
    databaseUrl: required("DATABASE_URL"),
    port: positiveInteger("PORT", 3000),
    bankAUrl: required("BANK_A_URL"),
    bankBUrl: required("BANK_B_URL"),
    bankAAccountId: required("BANK_A_ACCOUNT_ID"),
    bankBAccountId: required("BANK_B_ACCOUNT_ID"),
    participantTimeoutMs: positiveInteger("PARTICIPANT_TIMEOUT_MS", 4000),
  };
}
