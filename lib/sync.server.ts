import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/app/db.server";
import { parseMarelviFeed, type MarelviProduct } from "@/lib/marelvi";
import { findMarelviLocation, findMarelviShopifyBatch, writeShopifyUpdates } from "@/lib/shopify.server";

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
  unmatchedLocationSkuCount?: number;
  identityMismatchCount?: number;
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
    const dryRun = process.env.MARELVI_LIVE_SYNC_ENABLED !== "true";
    const feed = await fetchFeed();
    const state = await prisma.marelviSyncState.findUniqueOrThrow({ where: { id: stateId } });
    const location = await findMarelviLocation();
    const page = await findMarelviShopifyBatch(feed, state.shopifyCursor, location.id, BATCH_SIZE);
    const pageProducts = page.matches.map((match) => match.supplier);
    const skus = pageProducts.map((product) => product.sku);
    const snapshots = skus.length
      ? await prisma.marelviProductSnapshot.findMany({ where: { sku: { in: skus } } })
      : [];
    const bySku = new Map(snapshots.map((item) => [item.sku, item]));
    const matches = page.matches.map((match) => {
      const old = bySku.get(match.supplier.sku);
      return {
        ...match,
        needsPriceSync: !old || old.lastPriceSyncedHash !== match.supplier.hash,
        needsStockSync: !old || old.lastStockSyncedHash !== match.supplier.hash,
      };
    });
    const pending = matches.filter((match) => match.needsPriceSync || match.needsStockSync);
    const priceCandidates = pending.filter((match) => match.needsPriceSync).length;
    const stockCandidates = pending.filter((match) => match.needsStockSync).length;
    const zeroPriceSkus = matches.filter((match) => match.supplier.price === null).map((match) => match.supplier.sku);

    runId = (await prisma.marelviSyncRun.create({
      data: {
        dryRun,
        feedCount: feed.length,
        processedCount: page.processedCount,
        priceCandidates,
        stockCandidates,
      },
      select: { id: true },
    })).id;

    let priceUpdated = 0;
    let stockUpdated = 0;
    const stockSkipped = matches.filter((match) =>
      match.needsStockSync &&
      (!match.inventoryTracked || !match.inventoryLevelActive || match.currentAvailable === null),
    ).length;

    if (!dryRun && pending.length > 0) {
      const written = await writeShopifyUpdates(pending, location.id, runId);
      priceUpdated = written.priceUpdated;
      stockUpdated = written.stockUpdated;
    }

    if (!dryRun) {
      const priceSyncedSkus = new Set(
        matches
          .filter((match) => match.needsPriceSync && match.supplier.price !== null)
          .map((match) => match.supplier.sku),
      );
      const stockSyncedSkus = new Set(
        matches
          .filter((match) =>
            match.needsStockSync &&
            match.inventoryTracked &&
            match.inventoryLevelActive &&
            match.currentAvailable !== null,
          )
          .map((match) => match.supplier.sku),
      );
      const priceSyncedAt = new Date();
      for (const product of pageProducts) {
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
      for (const product of pageProducts) {
        await prisma.marelviProductSnapshot.upsert({
          where: { sku: product.sku },
          create: mapForSnapshot(product),
          update: mapForSnapshot(product),
        });
      }
    }

    const skippedCount = page.unmatchedCount + page.ambiguousSkus.length + stockSkipped;
    await prisma.marelviSyncRun.update({
      where: { id: runId },
      data: {
        status: dryRun ? "dry_run" : "completed",
        completedAt: new Date(),
        matchedCount: matches.length,
        unmatchedCount: page.unmatchedCount,
        ambiguousCount: page.ambiguousSkus.length,
        priceUpdated,
        stockUpdated,
        skippedCount,
        details: {
          ambiguousSkus: page.ambiguousSkus,
          unmatchedLocationSkuCount: page.unmatchedLocationSkuCount,
          identityMismatchCount: page.identityMismatchCount,
          stockSkipped,
          zeroPriceSkus,
        },
      },
    });
    await prisma.marelviSyncState.update({
      where: { id: stateId },
      data: {
        shopifyCursor: page.nextCursor,
        lastCycleAt: page.cycleComplete ? new Date() : undefined,
      },
    });

    return {
      status: dryRun ? "dry_run" : "completed",
      dryRun,
      runId,
      feedCount: feed.length,
      batchCount: page.processedCount,
      matchedCount: matches.length,
      unmatchedCount: page.unmatchedCount,
      ambiguousCount: page.ambiguousSkus.length,
      priceCandidates,
      stockCandidates,
      priceUpdated,
      stockUpdated,
      stockSkipped,
      unmatchedLocationSkuCount: page.unmatchedLocationSkuCount,
      identityMismatchCount: page.identityMismatchCount,
      cycleComplete: page.cycleComplete,
      unmatchedSkus: [],
      ambiguousSkus: page.ambiguousSkus,
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
