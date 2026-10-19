-- CreateEnum
CREATE TYPE "ScheduledDeletionStatus" AS ENUM ('pending', 'cancelled', 'completed');

-- CreateTable
CREATE TABLE "ScheduledAccountDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ScheduledDeletionStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "cancellationTokenHash" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledAccountDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledAccountDeletion_cancellationTokenHash_key" ON "ScheduledAccountDeletion"("cancellationTokenHash");

-- CreateIndex
CREATE INDEX "ScheduledAccountDeletion_userId_status_idx" ON "ScheduledAccountDeletion"("userId", "status");

-- CreateIndex
CREATE INDEX "ScheduledAccountDeletion_status_scheduledFor_idx" ON "ScheduledAccountDeletion"("status", "scheduledFor");

-- AddForeignKey
ALTER TABLE "ScheduledAccountDeletion" ADD CONSTRAINT "ScheduledAccountDeletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
