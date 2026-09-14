-- AlterTable
ALTER TABLE "DistributedTransaction" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DistributedTransaction_idempotencyKey_key" ON "DistributedTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DistributedTransaction_createdAt_idx" ON "DistributedTransaction"("createdAt");
