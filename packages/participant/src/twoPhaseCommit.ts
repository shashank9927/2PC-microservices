import { Pool, PoolClient } from "pg";

export type Operation = {
  kind: "debit" | "credit" | "read_only";
  accountId: string;
  amountCents?: number;
};

export type ResolutionResult = "committed" | "rolled_back" | "not_found";

// PostgreSQL does not parameterize transaction identifiers. We validate and
// quote them here rather than interpolating untrusted values into SQL.
function preparedTransactionLiteral(transactionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(transactionId)) {
    throw new Error("Invalid prepared transaction id");
  }
  return `'${transactionId}'`;
}

async function hasPreparedTransaction(client: PoolClient, transactionId: string): Promise<boolean> {
  const result = await client.query<{ gid: string }>(
    "SELECT gid FROM pg_prepared_xacts WHERE gid = $1 AND database = current_database()",
    [transactionId],
  );
  return result.rowCount === 1;
}

export async function prepareOperation(
  pool: Pool,
  transactionId: string,
  operation: Operation,
): Promise<"prepared" | "already_prepared" | "read_only"> {
  const client = await pool.connect();
  let prepared = false;
  let inTransaction = false;
  try {
    // Read-Only / 1PC Optimization:
    // In classic XA / 2PC, if a participant only performed read operations or had zero
    // balance delta, it votes VOTE_READ_ONLY in Phase 1.
    // We check that the account exists, but skip row locking (FOR UPDATE), skip balance update,
    // and skip PREPARE TRANSACTION so no locks or prepared transactions are held in PostgreSQL.
    if (operation.kind === "read_only" || operation.amountCents === 0) {
      const account = await client.query<{ balanceCents: number }>(
        'SELECT "balanceCents" FROM "Account" WHERE id = $1',
        [operation.accountId],
      );
      if (account.rowCount !== 1) throw new Error(`Account ${operation.accountId} does not exist`);
      return "read_only";
    }

    // A request retry after a coordinator timeout must not create a second
    // transaction. The already-prepared GID is the durable idempotency key.
    if (await hasPreparedTransaction(client, transactionId)) return "already_prepared";

    await client.query("BEGIN");
    inTransaction = true;
    const account = await client.query<{ balanceCents: number }>(
      'SELECT "balanceCents" FROM "Account" WHERE id = $1 FOR UPDATE',
      [operation.accountId],
    );
    if (account.rowCount !== 1) throw new Error(`Account ${operation.accountId} does not exist`);

    const currentBalance = account.rows[0].balanceCents;
    const amount = operation.amountCents ?? 0;
    if (operation.kind === "debit" && currentBalance < amount) {
      throw new Error("Insufficient funds");
    }

    const delta = operation.kind === "debit" ? -amount : amount;
    await client.query(
      'UPDATE "Account" SET "balanceCents" = "balanceCents" + $1, "updatedAt" = NOW() WHERE id = $2',
      [delta, operation.accountId],
    );

    // This must run on the very same checked-out pg connection as BEGIN and
    // the update. Prisma's normal query APIs do not promise that affinity.
    await client.query(`PREPARE TRANSACTION ${preparedTransactionLiteral(transactionId)}`);
    prepared = true;
    return "prepared";
  } finally {
    if (inTransaction && !prepared) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    client.release();
  }
}

export async function resolvePreparedTransaction(
  pool: Pool,
  transactionId: string,
  decision: "COMMIT" | "ABORT",
): Promise<ResolutionResult> {
  const client = await pool.connect();
  try {
    if (!(await hasPreparedTransaction(client, transactionId))) return "not_found";
    const command = decision === "COMMIT" ? "COMMIT PREPARED" : "ROLLBACK PREPARED";
    await client.query(`${command} ${preparedTransactionLiteral(transactionId)}`);
    return decision === "COMMIT" ? "committed" : "rolled_back";
  } finally {
    client.release();
  }
}
