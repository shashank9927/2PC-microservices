CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
