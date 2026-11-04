import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/app/db.server";
import { parseMarelviFeed, type MarelviProduct } from "@/lib/marelvi";
import { findMarelviLocation, findVariantsBySku, writeShopifyUpdates } from "@/lib/shopify.server";

const BATCH_SIZE = Math.min(Math.max(Number(process.env.MARELVI_BATCH_SIZE || 1000), 25), 1000);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function safeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "INTERNAL_ERROR";
  return /^[A-Z0-9_]+$/.test(raw) ? raw : "INTERNAL_ERROR";
}

function validateFeedUrl(): string {
  const value = required("MARELVI_FEED_URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("INVALID_MARELVI_FEED_URL"); }
  if (url.protocol !== "https:" || !/(^|\.)marelvi\.ro$/i.test(url.hostname)) {
    throw new Error("INVALID_MARELVI_FEED_HOST");
  }
  return url.toString();
}

async function fetchFeed(): Promise<MarelviProduct[]> {
  const url = validateFeedUrl();
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`MARELVI_FEED_HTTP_${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (body.length > 25_000_000) throw new Error("MARELVI_FEED_TOO_LARGE");
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new Error("MARELVI_FEED_INVALID_JSON"); }
  if (!contentType.toLowerCase().includes("json") && !body.trimStart().startsWith("{")) {
    throw new Error("MARELVI_FEED_NOT_JSON");
  }
  return parseMarelviFeed(json);
}

function mapForSnapshot(product: MarelviProduct) {
  return {
    sku: product.sku,
    title: product.title || product.sku,
    brand: product.brand,
    availability: product.availability,
    netPrice: product.netPrice.toFixed(2),
    greenFeeNet: product.greenFeeNet.toFixed(2),
    calculatedPrice: product.price?.toFixed(2) ?? null,
    compareAtPrice: product.compareAtPrice?.toFixed(2) ?? null,
    desiredStock: product.stock,
    sourceHash: product.hash,
    lastSeenAt: new Date(),
  };
}

export type MarelviSyncResult = {
  status: "dry_run" | "completed" | "busy";
  dryRun: boolean;
  runId?: string;
  feedCount?: number;
  batchCount?: number;
  matchedCount?: number;
  unmatchedCount?: number;
  ambiguousCount?: number;
  priceCandidates?: number;
  stockCandidates?: number;
  priceUpdated?: number;
  stockUpdated?: number;
  stockSkipped?: number;
  cursor?: number;
  cycleComplete?: boolean;
  zeroPriceSkus?: string[];
  unmatchedSkus?: string[];
  ambiguousSkus?: string[];
};

export async function runMarelviSync(): Promise<MarelviSyncResult> {
  const token = randomUUID();
  const stateId = "primary";
  const now = new Date();
  const lockExpiry = new Date(now.getTime() + 6 * 60 * 1000);

  await prisma.marelviSyncState.upsert({
    where: { id: stateId },
    create: { id: stateId },
    update: {},
  });
  const lock = await prisma.marelviSyncState.updateMany({
    where: { id: stateId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockToken: token, lockedUntil: lockExpiry },
  });
  if (lock.count !== 1) return { status: "busy", dryRun: process.env.MARELVI_LIVE_SYNC_ENABLED !== "true" };

  let runId: string | undefined;
  try {
    // Fail closed: live writes remain disabled until an explicit post-dry-run approval flag is set.
    const dryRun = process.env.MARELVI_LIVE_SYNC_ENABLED !== "true";
    const feed = await fetchFeed();
    const state = await prisma.marelviSyncState.findUniqueOrThrow({ where: { id: stateId } });
    const start = state.cursor >= feed.length ? 0 : state.cursor;
    const batch = feed.slice(start, Math.min(start + BATCH_SIZE, feed.length));
    const skus = batch.map((product) => product.sku);
    const snapshots = await prisma.marelviProductSnapshot.findMany({ where: { sku: { in: skus } } });
    const bySku = new Map(snapshots.map((item) => [item.sku, item]));
    const pending = batch.filter((product) => {
      const old = bySku.get(product.sku);
      return !old || old.lastPriceSyncedHash !== product.hash || old.lastStockSyncedHash !== product.hash;
    });
    const priceCandidates = pending.filter((product) => bySku.get(product.sku)?.lastPriceSyncedHash !== product.hash).length;
    const stockCandidates = pending.filter((product) => bySku.get(product.sku)?.lastStockSyncedHash !== product.hash).length;

    runId = (await prisma.marelviSyncRun.create({
      data: { dryRun, feedCount: feed.length, processedCount: batch.length, priceCandidates, stockCandidates },
      select: { id: true },
    })).id;

    let matchedCount = 0;
    let unmatchedSkus: string[] = [];
    let ambiguousSkus: string[] = [];
    let priceUpdated = 0;
    let stockUpdated = 0;
    let stockSkipped = 0;
    const zeroPriceSkus = batch.filter((product) => product.price === null).map((product) => product.sku);
    let nextCursor = start + batch.length;
    const cycleComplete = nextCursor >= feed.length;
    if (cycleComplete) nextCursor = 0;

    if (pending.length > 0) {
      const location = await findMarelviLocation();
      const found = await findVariantsBySku(pending, location.id);
      matchedCount = found.matches.length;
      unmatchedSkus = found.unmatchedSkus;
      ambiguousSkus = found.ambiguousSkus;
      stockSkipped = found.matches.filter((match) => {
        const old = bySku.get(match.supplier.sku);
        const needsStockSync = !old || old.lastStockSyncedHash !== match.supplier.hash;
        return needsStockSync && (!match.inventoryTracked || !match.inventoryLevelActive || match.currentAvailable === null);
      }).length;

      const matches = found.matches.map((match) => {
        const old = bySku.get(match.supplier.sku);
        return {
          ...match,
          needsPriceSync: !old || old.lastPriceSyncedHash !== match.supplier.hash,
          needsStockSync: !old || old.lastStockSyncedHash !== match.supplier.hash,
        };
      });

      if (!dryRun && matches.length > 0) {
        const written = await writeShopifyUpdates(matches, location.id, runId);
        priceUpdated = written.priceUpdated;
        stockUpdated = written.stockUpdated;
      }

      if (!dryRun) {
        const priceSyncedSkus = new Set(matches.filter((match) => match.needsPriceSync && match.supplier.price !== null).map((match) => match.supplier.sku));
        const stockSyncedSkus = new Set(matches.filter((match) => match.needsStockSync && match.inventoryTracked && match.inventoryLevelActive && match.currentAvailable !== null).map((match) => match.supplier.sku));
        const priceSyncedAt = new Date();
        for (const product of batch) {
          const data = mapForSnapshot(product);
          const priceDone = priceSyncedSkus.has(product.sku);
          const stockDone = stockSyncedSkus.has(product.sku);
          await prisma.marelviProductSnapshot.upsert({
            where: { sku: product.sku },
            create: {
              ...data,
              lastPriceSyncedHash: priceDone ? product.hash : null,
              lastStockSyncedHash: stockDone ? product.hash : null,
              lastSyncedAt: priceDone || stockDone ? priceSyncedAt : null,
            },
            update: {
              ...data,
              ...(priceDone ? { lastPriceSyncedHash: product.hash } : {}),
              ...(stockDone ? { lastStockSyncedHash: product.hash } : {}),
              ...(priceDone || stockDone ? { lastSyncedAt: priceSyncedAt } : {}),
            },
          });
        }
      } else {
        for (const product of batch) {
          await prisma.marelviProductSnapshot.upsert({
            where: { sku: product.sku },
            create: mapForSnapshot(product),
            update: mapForSnapshot(product),
          });
        }
      }
    }

    const skippedCount = unmatchedSkus.length + ambiguousSkus.length + stockSkipped;
    await prisma.marelviSyncRun.update({
      where: { id: runId },
      data: {
        status: dryRun ? "dry_run" : "completed",
        completedAt: new Date(),
        matchedCount,
        unmatchedCount: unmatchedSkus.length,
        ambiguousCount: ambiguousSkus.length,
        priceUpdated,
        stockUpdated,
        skippedCount,
        details: { unmatchedSkus: unmatchedSkus.slice(0, 200), ambiguousSkus, stockSkipped, zeroPriceSkus },
      },
    });
    await prisma.marelviSyncState.update({
      where: { id: stateId },
      data: { cursor: nextCursor, lastCycleAt: cycleComplete ? new Date() : undefined },
    });

    return {
      status: dryRun ? "dry_run" : "completed",
      dryRun,
      runId,
      feedCount: feed.length,
      batchCount: batch.length,
      matchedCount,
      unmatchedCount: unmatchedSkus.length,
      ambiguousCount: ambiguousSkus.length,
      priceCandidates,
      stockCandidates,
      priceUpdated,
      stockUpdated,
      stockSkipped,
      cursor: nextCursor,
      cycleComplete,
      unmatchedSkus: unmatchedSkus.slice(0, 50),
      ambiguousSkus,
      zeroPriceSkus,
    };
  } catch (error) {
    if (runId) {
      await prisma.marelviSyncRun.update({
        where: { id: runId },
        data: { status: "failed", completedAt: new Date(), errorCode: safeErrorCode(error) },
      }).catch(() => undefined);
    }
    throw new Error(safeErrorCode(error));
  } finally {
    await prisma.marelviSyncState.updateMany({
      where: { id: stateId, lockToken: token },
      data: { lockToken: null, lockedUntil: null },
    }).catch(() => undefined);
  }
}

export function feedFingerprint(products: MarelviProduct[]): string {
  return createHash("sha256").update(products.map((product) => product.hash).join("|")).digest("hex");
}
