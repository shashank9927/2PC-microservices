-- This is the coordinator's write-ahead decision log. A decision is committed
-- here before any participant receives COMMIT PREPARED / ROLLBACK PREPARED.
CREATE TYPE "Decision" AS ENUM ('COMMIT', 'ABORT');
CREATE TYPE "CoordinatorStatus" AS ENUM ('PREPARING', 'DECIDED', 'COMPLETING', 'COMPLETED');

CREATE TABLE "DistributedTransaction" (
    "id" TEXT NOT NULL,
    "participants" JSONB NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "decision" "Decision",
    "status" "CoordinatorStatus" NOT NULL DEFAULT 'PREPARING',
    "prepareError" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DistributedTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DistributedTransaction_status_idx" ON "DistributedTransaction"("status");
CREATE INDEX "DistributedTransaction_decision_idx" ON "DistributedTransaction"("decision");
