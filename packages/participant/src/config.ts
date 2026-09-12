export interface ParticipantConfig {
  databaseUrl: string;
  name: string;
  port: number;
  initialAccountId: string;
  initialBalanceCents: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): ParticipantConfig {
  return {
    databaseUrl: required("DATABASE_URL"),
    name: required("PARTICIPANT_NAME"),
    port: positiveInteger("PORT", 3001),
    initialAccountId: required("PARTICIPANT_ACCOUNT_ID"),
    initialBalanceCents: positiveInteger("PARTICIPANT_INITIAL_BALANCE_CENTS", 1),
  };
}
