-- CreateEnum
CREATE TYPE "ScheduledPaymentStatus" AS ENUM ('active', 'paused', 'cancelled');

-- CreateTable
CREATE TABLE "ScheduledPayment" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "walletAddress" TEXT,
    "cronExpression" TEXT NOT NULL,
    "status" "ScheduledPaymentStatus" NOT NULL DEFAULT 'active',
    "lastRunAt" TIMESTAMP(3),
    "lastPayoutId" TEXT,
    "lastRunError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPayment_creatorId_status_idx" ON "ScheduledPayment"("creatorId", "status");

-- CreateIndex
CREATE INDEX "ScheduledPayment_status_idx" ON "ScheduledPayment"("status");

-- AddForeignKey
ALTER TABLE "ScheduledPayment" ADD CONSTRAINT "ScheduledPayment_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
