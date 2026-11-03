CREATE TABLE "MarelviSyncState" (
  "id" TEXT NOT NULL,
  "cursor" INTEGER NOT NULL DEFAULT 0,
  "lockToken" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "lastCycleAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarelviSyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarelviSyncRun" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'running',
  "dryRun" BOOLEAN NOT NULL DEFAULT true,
  "feedCount" INTEGER NOT NULL DEFAULT 0,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
  "ambiguousCount" INTEGER NOT NULL DEFAULT 0,
  "priceCandidates" INTEGER NOT NULL DEFAULT 0,
  "stockCandidates" INTEGER NOT NULL DEFAULT 0,
  "priceUpdated" INTEGER NOT NULL DEFAULT 0,
  "stockUpdated" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "details" JSONB,
  "errorCode" TEXT,
  CONSTRAINT "MarelviSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarelviProductSnapshot" (
  "sku" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "brand" TEXT NOT NULL,
  "availability" TEXT NOT NULL,
  "netPrice" DECIMAL(12,2) NOT NULL,
  "greenFeeNet" DECIMAL(12,2) NOT NULL,
  "calculatedPrice" DECIMAL(12,2),
  "compareAtPrice" DECIMAL(12,2),
  "desiredStock" INTEGER NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "lastPriceSyncedHash" TEXT,
  "lastStockSyncedHash" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSyncedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarelviProductSnapshot_pkey" PRIMARY KEY ("sku")
);
