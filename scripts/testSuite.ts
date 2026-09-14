import { createParticipantApp } from "../packages/participant/src/app";
import { createCoordinatorApp } from "../packages/coordinator/src/app";
import { PrismaClient as CoordinatorPrismaClient } from "../packages/coordinator/src/generated/client";
import { PrismaClient as ParticipantPrismaClient } from "../packages/participant/src/generated/client";
import type { Server } from "node:http";

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
  error?: string;
}

const results: TestResult[] = [];

async function runTests() {
  console.log("=== Starting 2PC Microservices Test Suite ===");

  const PG_PORT = 54329;
  const coordinatorDbUrl = `postgresql://postgres@127.0.0.1:54329/coordinator?schema=public`;
  const bankADbUrl = `postgresql://postgres@127.0.0.1:54329/bank_a?schema=public`;
  const bankBDbUrl = `postgresql://postgres@127.0.0.1:54330/bank_b?schema=public`;

  const bankAConfig = {
    databaseUrl: bankADbUrl,
    name: "bank-a",
    port: 3011,
    initialAccountId: "alice",
    initialBalanceCents: 100000,
  };

  const bankBConfig = {
    databaseUrl: bankBDbUrl,
    name: "bank-b",
    port: 3012,
    initialAccountId: "bob",
    initialBalanceCents: 50000,
  };

  const coordinatorConfig = {
    databaseUrl: coordinatorDbUrl,
    port: 3010,
    bankAUrl: "http://127.0.0.1:3011",
    bankBUrl: "http://127.0.0.1:3012",
    bankAAccountId: "alice",
    bankBAccountId: "bob",
    participantTimeoutMs: 3000,
    reaperIntervalMs: 60000,
    stuckTransactionTimeoutMs: 60000,
  };

  // Reset database tables
  const coordPrisma = new CoordinatorPrismaClient({ datasourceUrl: coordinatorDbUrl });
  const bankAPrisma = new ParticipantPrismaClient({ datasourceUrl: bankADbUrl });
  const bankBPrisma = new ParticipantPrismaClient({ datasourceUrl: bankBDbUrl });

  await coordPrisma.$connect();
  await bankAPrisma.$connect();
  await bankBPrisma.$connect();

  await coordPrisma.distributedTransaction.deleteMany();
  await bankAPrisma.account.deleteMany();
  await bankBPrisma.account.deleteMany();

  // PrismaClient now uses datasourceUrl from config — no process.env needed
  const bankAInstance = await createParticipantApp(bankAConfig);
  const serverBankA: Server = bankAInstance.app.listen(bankAConfig.port);

  const bankBInstance = await createParticipantApp(bankBConfig);
  const serverBankB: Server = bankBInstance.app.listen(bankBConfig.port);

  const coordInstance = createCoordinatorApp(coordPrisma, coordinatorConfig);
  const serverCoord: Server = coordInstance.app.listen(coordinatorConfig.port);

  // Helper to fetch JSON
  async function api(url: string, options?: RequestInit) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  try {
    // TEST 1: Initial health and balances
    console.log("\n--- TEST 1: Service health and initial balances ---");
    const hCoord = await api("http://127.0.0.1:3010/health");
    const hBankA = await api("http://127.0.0.1:3011/health");
    const hBankB = await api("http://127.0.0.1:3012/health");
    const accA = await api("http://127.0.0.1:3011/accounts");
    const accB = await api("http://127.0.0.1:3012/accounts");

    const t1Passed =
      hCoord.status === 200 &&
      hBankA.status === 200 &&
      hBankB.status === 200 &&
      accA.body.accounts?.[0]?.balanceCents === 100000 &&
      accB.body.accounts?.[0]?.balanceCents === 50000;

    results.push({
      name: "Health and Initial Balance Setup",
      passed: t1Passed,
      details: `Alice: ${accA.body.accounts?.[0]?.balanceCents}, Bob: ${accB.body.accounts?.[0]?.balanceCents}`,
    });

    // TEST 2: Successful 2PC Transfer
    console.log("\n--- TEST 2: Successful 2PC commit transfer (2500 cents) ---");
    const transferRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 2500 }),
    });

    console.log("Transfer response:", JSON.stringify(transferRes));
    const postAccA = await api("http://127.0.0.1:3011/accounts");
    const postAccB = await api("http://127.0.0.1:3012/accounts");

    const t2Passed =
      transferRes.status === 201 &&
      transferRes.body.decision === "COMMIT" &&
      transferRes.body.complete === true &&
      postAccA.body.accounts?.[0]?.balanceCents === 97500 &&
      postAccB.body.accounts?.[0]?.balanceCents === 52500;

    results.push({
      name: "Standard 2PC Transfer Commit",
      passed: t2Passed,
      details: `Status: ${transferRes.status}, Decision: ${transferRes.body.decision}, Alice: ${postAccA.body.accounts?.[0]?.balanceCents}, Bob: ${postAccB.body.accounts?.[0]?.balanceCents}`,
    });

    // TEST 3: Shared PostgreSQL cluster cross-database pg_prepared_xacts bug
    console.log("\n--- TEST 3: Cross-database pg_prepared_xacts isolation check ---");
    // If Bank A and Bank B are in the same cluster, Bank B sees Bank A's prepared transactions if not filtered by database
    // Let's test by checking Bank A's prepared transactions vs Bank B's
    const prepA = await api("http://127.0.0.1:3011/prepared");
    const prepB = await api("http://127.0.0.1:3012/prepared");
    // Prepare a transaction directly on Bank A
    const directPrep = await api("http://127.0.0.1:3011/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: "test-isolation-123",
        operation: { kind: "debit", accountId: "alice", amountCents: 500 },
      }),
    });
    // Check if Bank B sees this transaction in /prepared
    const prepBAfterA = await api("http://127.0.0.1:3012/prepared");
    const bankBSeesBankA = prepBAfterA.body.prepared?.some((x: any) => x.gid === "test-isolation-123");
    // Also test: what if we now try to prepare Bank B with the same transactionId?
    const prepBWithSameId = await api("http://127.0.0.1:3012/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: "test-isolation-123",
        operation: { kind: "credit", accountId: "bob", amountCents: 500 },
      }),
    });

    // Clean up direct prepare on Bank A and Bank B
    await api("http://127.0.0.1:3011/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "test-isolation-123" }),
    });
    await api("http://127.0.0.1:3012/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "test-isolation-123" }),
    });

    results.push({
      name: "Cluster-Wide pg_prepared_xacts Collision Bug",
      passed: !bankBSeesBankA && prepBWithSameId.body.state !== "already_prepared",
      details: `Bank B sees Bank A tx: ${bankBSeesBankA}, Bank B prepare result: ${JSON.stringify(prepBWithSameId.body)}`,
    });

    // TEST 4: Forced Abort at Bank B
    console.log("\n--- TEST 4: Forced Abort at Bank B ---");
    const prevBalA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const prevBalB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    const forcedAbortRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 1250, forcePrepareFailureAt: "bank-b" }),
    });

    const postAbortA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const postAbortB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    const t4Passed =
      forcedAbortRes.status === 422 &&
      forcedAbortRes.body.decision === "ABORT" &&
      forcedAbortRes.body.complete === true &&
      postAbortA === prevBalA &&
      postAbortB === prevBalB;

    results.push({
      name: "Forced Abort (Phase 1 failure at Bank B & Rollback at Bank A)",
      passed: t4Passed,
      details: `HTTP status: ${forcedAbortRes.status} (expected 422), Decision: ${forcedAbortRes.body.decision}, Balances unchanged: ${postAbortA === prevBalA}`,
    });

    // TEST 5: Insufficient Funds
    console.log("\n--- TEST 5: Insufficient Funds ---");
    const currentA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const insuffRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: currentA + 100000 }),
    });
    const afterInsuffA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;

    results.push({
      name: "Insufficient Funds Abort",
      passed: insuffRes.status === 422 && insuffRes.body.decision === "ABORT" && currentA === afterInsuffA,
      details: `HTTP status: ${insuffRes.status} (expected 422), Decision: ${insuffRes.body.decision}, Balance intact: ${currentA === afterInsuffA}`,
    });

    // TEST 6: Invalid Account
    console.log("\n--- TEST 6: Invalid Account ---");
    const invalidAccRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAccountId: "nonexistent", amountCents: 100 }),
    });

    results.push({
      name: "Nonexistent Account Handling",
      passed: invalidAccRes.status === 422 && invalidAccRes.body.decision === "ABORT",
      details: `HTTP status: ${invalidAccRes.status} (expected 422), Decision: ${invalidAccRes.body.decision}`,
    });

    // TEST 7: Input Validation (Negative or Zero Amount)
    console.log("\n--- TEST 7: Input Validation (Zero/Negative Amount) ---");
    const zeroAmt = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 0 }),
    });
    const negAmt = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: -500 }),
    });

    results.push({
      name: "Zero/Negative Amount Validation",
      passed: zeroAmt.status === 400 && negAmt.status === 400,
      details: `Zero status: ${zeroAmt.status}, Neg status: ${negAmt.status}`,
    });

    // TEST 8: Row Lock Retention / Blocking during Prepared State
    console.log("\n--- TEST 8: Row Lock Retention & Concurrency Blocking ---");
    const lockTxId = "lock-test-row-001";
    await api("http://127.0.0.1:3011/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: lockTxId,
        operation: { kind: "debit", accountId: "alice", amountCents: 100 },
      }),
    });

    // Now try another prepare on Alice with timeout
    const startTime = Date.now();
    let blockedOrTimedOut = false;
    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 1500);
      const blockedReq = await fetch("http://127.0.0.1:3011/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId: "lock-test-row-002",
          operation: { kind: "debit", accountId: "alice", amountCents: 100 },
        }),
        signal: abortController.signal,
      });
      clearTimeout(timeout);
    } catch (e: any) {
      if (e.name === "AbortError" || Date.now() - startTime >= 1400) {
        blockedOrTimedOut = true;
      }
    }

    // Release the lock
    await api("http://127.0.0.1:3011/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: lockTxId }),
    });
    await new Promise((r) => setTimeout(r, 300));
    await api("http://127.0.0.1:3011/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "lock-test-row-002" }),
    });

    results.push({
      name: "Row Lock Blocking in Prepared State",
      passed: blockedOrTimedOut,
      details: `Second request blocked/timed out: ${blockedOrTimedOut}`,
    });

    // TEST 9: Operator Abort Endpoint
    console.log("\n--- TEST 9: Operator Abort Endpoint for Undecided Transaction ---");
    // Manually create a transaction in PREPARING status without decision
    const fakeTxId = "undecided-tx-001";
    // 3. Durably log DECIDED for operator abort test
    await coordPrisma.distributedTransaction.create({
      data: {
        id: fakeTxId,
        participants: [
          { name: "bank-a", url: "http://127.0.0.1:3011", accountId: "alice", phase: "pending" },
          { name: "bank-b", url: "http://127.0.0.1:3012", accountId: "bob", phase: "pending" },
        ],
        fromAccountId: "alice",
        toAccountId: "bob",
        amountCents: 100,
        status: "PREPARING",
      },
    });

    const opAbortRes = await api(`http://127.0.0.1:3010/transactions/${fakeTxId}/abort`, {
      method: "POST",
    });

    const dbTx = await coordPrisma.distributedTransaction.findUnique({ where: { id: fakeTxId } });

    results.push({
      name: "Operator Abort for Undecided Transaction",
      passed: opAbortRes.status === 200 && dbTx?.decision === "ABORT" && dbTx?.status === "COMPLETED",
      details: `Status: ${opAbortRes.status}, Decision: ${dbTx?.decision}, DB Status: ${dbTx?.status}`,
    });

    // TEST 10: Participant Idempotency on Rollback / Commit
    console.log("\n--- TEST 10: Participant Idempotent Resolution ---");
    const dummyRollback = await api("http://127.0.0.1:3011/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "non-existent-tx-999" }),
    });
    const dummyCommit = await api("http://127.0.0.1:3011/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "non-existent-tx-999" }),
    });

    results.push({
      name: "Participant Resolution of Non-Existent GID",
      passed: dummyRollback.body.state === "not_found" && dummyCommit.body.state === "not_found",
      details: `Rollback state: ${dummyRollback.body.state}, Commit state: ${dummyCommit.body.state}`,
    });

    // TEST 11: HTTP Status Code Semantics for Aborted Transactions
    console.log("\n--- TEST 11: HTTP Status Code Semantics on Abort ---");
    const abortHttpStatus = forcedAbortRes.status;
    results.push({
      name: "HTTP Status Code Semantics on Abort (422 Unprocessable Entity)",
      passed: abortHttpStatus === 422,
      details: `Returned HTTP status: ${abortHttpStatus} for aborted transfer (Expected 422)`,
    });

    // TEST 12: Recovery Replay of Decided Transaction
    console.log("\n--- TEST 12: Crash Recovery Replay ---");
    const crashTxId = "crash-recovery-001";
    // 1. Prepare Bank A directly
    await api("http://127.0.0.1:3011/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: crashTxId,
        operation: { kind: "debit", accountId: "alice", amountCents: 1000 },
      }),
    });
    // 2. Prepare Bank B directly
    await api("http://127.0.0.1:3012/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: crashTxId,
        operation: { kind: "credit", accountId: "bob", amountCents: 1000 },
      }),
    });
    // 3. Durably log DECIDED in coordinator DB (simulating coordinator crash right after logging decision)
    await coordPrisma.distributedTransaction.create({
      data: {
        id: crashTxId,
        // accountId is required by the updated parseParticipants validation
        participants: [
          { name: "bank-a", url: "http://127.0.0.1:3011", accountId: "alice", phase: "prepared" },
          { name: "bank-b", url: "http://127.0.0.1:3012", accountId: "bob", phase: "prepared" },
        ],
        fromAccountId: "alice",
        toAccountId: "bob",
        amountCents: 1000,
        decision: "COMMIT",
        status: "DECIDED",
      },
    });

    const balBeforeRecA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const balBeforeRecB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    // Run recovery
    const recRes = await api("http://127.0.0.1:3010/recovery/run", { method: "POST" });
    const balAfterRecA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const balAfterRecB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    const crashDbTx = await coordPrisma.distributedTransaction.findUnique({ where: { id: crashTxId } });

    const t12Passed =
      crashDbTx?.status === "COMPLETED" &&
      balAfterRecA === balBeforeRecA - 1000 &&
      balAfterRecB === balBeforeRecB + 1000;

    results.push({
      name: "Crash Recovery Replay & State Convergence",
      passed: t12Passed,
      details: `DB Status: ${crashDbTx?.status}, Alice delta: ${balAfterRecA - balBeforeRecA}, Bob delta: ${balAfterRecB - balBeforeRecB}`,
    });

    // TEST 13: Reverse Direction Transfer (Bob -> Alice)
    console.log("\n--- TEST 13: Reverse Direction Transfer (Bob -> Alice) ---");
    const reverseRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAccountId: "bob", toAccountId: "alice", amountCents: 500 }),
    });

    results.push({
      name: "Bidirectional Transfer Support (Reverse Bob -> Alice)",
      passed: reverseRes.body.decision === "COMMIT" && reverseRes.body.complete === true,
      details: `Decision: ${reverseRes.body.decision}, Errors: ${JSON.stringify(reverseRes.body.errors || [])}`,
    });

    // TEST 14: Participant Phase Overwrite on Rollback
    console.log("\n--- TEST 14: Participant Phase Overwrite Bug Check ---");
    const txList = await api("http://127.0.0.1:3010/transactions");
    const forcedTx = txList.body.find((t: any) => t.id === forcedAbortRes.body.transactionId);
    const bankBParticipant = forcedTx?.participants?.find((p: any) => p.name === "bank-b");
    const phaseOverwritten = bankBParticipant?.phase === "rolled_back";

    results.push({
      name: "Audit Log Integrity (Phase Overwrite on Rollback)",
      passed: !phaseOverwritten, // It should NOT overwrite prepare_failed with rolled_back
      details: `Bank B final recorded phase in participants array: '${bankBParticipant?.phase}' (Was prepare_failed, became ${bankBParticipant?.phase})`,
    });

    // TEST 15: Idempotency Key Replay (Exact Duplicate)
    console.log("\n--- TEST 15: Idempotency Key Replay (Exact Duplicate) ---");
    const bal15BeforeA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const bal15BeforeB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    const idemKey1 = "idempotency-key-test-001";
    const firstIdemRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey1 },
      body: JSON.stringify({ amountCents: 1500 }),
    });

    const bal15MidA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const bal15MidB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    // Send the exact duplicate request with same idempotency key
    const secondIdemRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey1 },
      body: JSON.stringify({ amountCents: 1500 }),
    });

    const bal15AfterA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const bal15AfterB = (await api("http://127.0.0.1:3012/accounts")).body.accounts?.[0]?.balanceCents;

    const t15Passed =
      firstIdemRes.status === 201 &&
      secondIdemRes.status === 201 &&
      secondIdemRes.body.transactionId === firstIdemRes.body.transactionId &&
      secondIdemRes.body.decision === "COMMIT" &&
      bal15MidA === bal15BeforeA - 1500 &&
      bal15MidB === bal15BeforeB + 1500 &&
      bal15AfterA === bal15MidA &&
      bal15AfterB === bal15MidB;

    results.push({
      name: "Idempotency Key Exact Replay (Duplicate Transfer Prevention)",
      passed: t15Passed,
      details: `First TxId: ${firstIdemRes.body.transactionId}, Second TxId: ${secondIdemRes.body.transactionId}, Second status: ${secondIdemRes.status}, Alice delta: ${bal15AfterA - bal15BeforeA}`,
    });

    // TEST 16: Idempotency Key Parameter Mismatch
    console.log("\n--- TEST 16: Idempotency Key Parameter Mismatch Conflict ---");
    const mismatchRes = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey1 },
      body: JSON.stringify({ amountCents: 9999 }),
    });

    const bal16AfterA = (await api("http://127.0.0.1:3011/accounts")).body.accounts?.[0]?.balanceCents;
    const t16Passed = mismatchRes.status === 422 && bal16AfterA === bal15AfterA;

    results.push({
      name: "Idempotency Key Parameter Mismatch Rejection",
      passed: t16Passed,
      details: `Status: ${mismatchRes.status} (Expected 422), Error: ${mismatchRes.body.error}`,
    });

    // TEST 17: Idempotency Key on Aborted Transfer Replay
    console.log("\n--- TEST 17: Idempotency Key on Aborted Transfer Replay ---");
    const idemAbortKey = "idempotency-abort-test-001";
    const abortFirst = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemAbortKey },
      body: JSON.stringify({ amountCents: 100, forcePrepareFailureAt: "bank-b" }),
    });

    const abortSecond = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemAbortKey },
      body: JSON.stringify({ amountCents: 100, forcePrepareFailureAt: "bank-b" }),
    });

    const t17Passed =
      abortFirst.status === 422 &&
      abortSecond.status === 422 &&
      abortSecond.body.transactionId === abortFirst.body.transactionId &&
      abortSecond.body.decision === "ABORT";

    results.push({
      name: "Idempotency Key on Aborted Transfer Replay",
      passed: t17Passed,
      details: `First status: ${abortFirst.status}, Second status: ${abortSecond.status}, Decision: ${abortSecond.body.decision}`,
    });

    // TEST 18: Automated Stuck-Transaction Reaper
    console.log("\n--- TEST 18: Automated Stuck-Transaction Reaper ---");
    const stuckTxId = "stuck-reaper-tx-001";

    // 1. Participant Bank A prepares and holds a lock on Alice
    await api("http://127.0.0.1:3011/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: stuckTxId,
        participantName: "bank-a",
        operation: { kind: "debit", accountId: "alice", amountCents: 500 },
      }),
    });

    // 2. Coordinator records transaction in PREPARING (simulating crash before decision was logged)
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await coordPrisma.distributedTransaction.create({
      data: {
        id: stuckTxId,
        participants: [
          { name: "bank-a", url: "http://127.0.0.1:3011", accountId: "alice", phase: "prepared" },
          { name: "bank-b", url: "http://127.0.0.1:3012", accountId: "bob", phase: "skipped" },
        ],
        fromAccountId: "alice",
        toAccountId: "bob",
        amountCents: 500,
        decision: null,
        status: "PREPARING",
        createdAt: twoMinutesAgo,
      },
    });

    const prepListBefore = await api("http://127.0.0.1:3011/prepared");
    const bankAHadLock = prepListBefore.body.prepared?.some((p: any) => p.gid === stuckTxId);

    // 3. Trigger reaper sweep via POST /reaper/run
    const reaperRes = await api("http://127.0.0.1:3010/reaper/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanMs: 30000 }),
    });

    // 4. Verify the stuck transaction was aborted and Bank A released the lock
    const dbTxAfterReap = await coordPrisma.distributedTransaction.findUnique({ where: { id: stuckTxId } });
    const prepListAfter = await api("http://127.0.0.1:3011/prepared");
    const bankAFreedLock = !prepListAfter.body.prepared?.some((p: any) => p.gid === stuckTxId);

    // Verify subsequent transfer on Alice succeeds immediately without blocking
    const afterReapTransfer = await api("http://127.0.0.1:3010/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 100 }),
    });

    const t18Passed =
      bankAHadLock &&
      bankAFreedLock &&
      reaperRes.body.reapedCount >= 1 &&
      dbTxAfterReap?.status === "COMPLETED" &&
      dbTxAfterReap?.decision === "ABORT" &&
      afterReapTransfer.status === 201;

    results.push({
      name: "Automated Stuck-Transaction Reaper & Row-Lock Release",
      passed: t18Passed,
      details: `Had lock before: ${bankAHadLock}, Freed lock after: ${bankAFreedLock}, Reaped count: ${reaperRes.body.reapedCount}, DB Status: ${dbTxAfterReap?.status}, Post-reap transfer: ${afterReapTransfer.status}`,
    });

  } finally {
    // Cleanup servers
    serverCoord.close();
    serverBankA.close();
    serverBankB.close();
    await bankAInstance.close();
    await bankBInstance.close();
    await coordPrisma.$disconnect();
    await bankAPrisma.$disconnect();
    await bankBPrisma.$disconnect();
  }

  console.log("\n==========================================");
  console.log("             TEST SUMMARY                 ");
  console.log("==========================================");
  for (const r of results) {
    const icon = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${icon}: ${r.name}`);
    if (r.details) console.log(`   Details: ${r.details}`);
    if (r.error) console.log(`   Error: ${r.error}`);
  }
}

runTests().catch(console.error);
