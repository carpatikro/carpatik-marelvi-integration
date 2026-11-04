import type { MarelviProduct } from "@/lib/marelvi";
import { randomUUID } from "node:crypto";

const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-10";
const shopDomain = (process.env.SHOPIFY_SHOP_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const targetLocationName = process.env.SHOPIFY_INVENTORY_LOCATION_NAME || "Rudeni Marelvi depozit";
const accessTokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

type ShopifyVariant = {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  product: { id: string };
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevel: null | { quantities: Array<{ name: string; quantity: number }> };
  };
};

export type MatchedVariant = {
  supplier: MarelviProduct;
  variant: ShopifyVariant;
  currentAvailable: number | null;
  inventoryTracked: boolean;
  inventoryLevelActive: boolean;
  needsPriceSync?: boolean;
  needsStockSync?: boolean;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

async function getAccessToken(): Promise<string> {
  required("SHOPIFY_SHOP_DOMAIN", shopDomain);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const clientId = required("SHOPIFY_CLIENT_ID", process.env.SHOPIFY_CLIENT_ID);
  const clientSecret = required("SHOPIFY_CLIENT_SECRET", process.env.SHOPIFY_CLIENT_SECRET);
  const response = await fetch(accessTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`SHOPIFY_TOKEN_HTTP_${response.status}`);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("SHOPIFY_TOKEN_MISSING");
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 86399) * 1000 };
  return data.access_token;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    lastStatus = response.status;
    if (response.ok) {
      const body = await response.json() as { data?: T; errors?: unknown[] };
      if (body.errors?.length) throw new Error("SHOPIFY_GRAPHQL_ERROR");
      if (!body.data) throw new Error("SHOPIFY_GRAPHQL_NO_DATA");
      return body.data;
    }
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, 8_000)));
  }
  throw new Error(`SHOPIFY_GRAPHQL_HTTP_${lastStatus}`);
}

export async function findMarelviLocation(): Promise<{ id: string; name: string }> {
  const data = await graphql<{ locations: { nodes: Array<{ id: string; name: string }> } }>(
    `query MarelviLocation { locations(first: 100) { nodes { id name } } }`, {},
  );
  const location = data.locations.nodes.find((item) => item.name.trim().toLocaleLowerCase("ro-RO") === targetLocationName.trim().toLocaleLowerCase("ro-RO"));
  if (!location) throw new Error("MARELVI_LOCATION_NOT_FOUND");
  return location;
}

export async function findVariantsBySku(products: MarelviProduct[], locationId: string): Promise<{
  matches: MatchedVariant[];
  unmatchedSkus: string[];
  ambiguousSkus: string[];
}> {
  const result = new Map<string, ShopifyVariant[]>();
  for (let start = 0; start < products.length; start += 25) {
    const batch = products.slice(start, start + 25);
    const queryString = batch.map((product) => `sku:${JSON.stringify(product.sku)}`).join(" OR ");
    const data = await graphql<{ productVariants: { nodes: ShopifyVariant[] } }>(
      `query MarelviVariants($search: String!, $locationId: ID!) {
        productVariants(first: 100, query: $search) {
          nodes {
            id sku barcode price compareAtPrice product { id }
            inventoryItem {
              id tracked
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }`,
      { search: queryString, locationId },
    );
    for (const variant of data.productVariants.nodes) {
      if (!variant.sku) continue;
      const key = variant.sku.trim();
      const list = result.get(key) ?? [];
      list.push(variant);
      result.set(key, list);
    }
  }

  const matches: MatchedVariant[] = [];
  const unmatchedSkus: string[] = [];
  const ambiguousSkus: string[] = [];
  for (const product of products) {
    const variants = result.get(product.sku) ?? [];
    if (variants.length === 0) { unmatchedSkus.push(product.sku); continue; }
    if (variants.length > 1) { ambiguousSkus.push(product.sku); continue; }
    const variant = variants[0];
    const quantity = variant.inventoryItem.inventoryLevel?.quantities.find((entry) => entry.name === "available")?.quantity;
    matches.push({
      supplier: product,
      variant,
      currentAvailable: typeof quantity === "number" ? quantity : null,
      inventoryTracked: variant.inventoryItem.tracked,
      inventoryLevelActive: variant.inventoryItem.inventoryLevel !== null,
    });
  }
  return { matches, unmatchedSkus, ambiguousSkus };
}

export async function findMarelviShopifyBatch(
  feed: MarelviProduct[],
  afterCursor: string | null,
  locationId: string,
  maxVariants: number,
): Promise<{
  matches: MatchedVariant[];
  ambiguousSkus: string[];
  unmatchedCount: number;
  unmatchedLocationSkuCount: number;
  identityMismatchCount: number;
  processedCount: number;
  nextCursor: string | null;
  cycleComplete: boolean;
}> {
  const feedBySku = new Map(feed.map((product) => [product.sku, product]));
  const candidatesBySku = new Map<string, ShopifyVariant>();
  let cursor = afterCursor;
  let hasNextPage = true;
  let processedCount = 0;
  let unmatchedLocationSkuCount = 0;
  let identityMismatchCount = 0;

  // Shopify is the traversal source. A variant is eligible only when its SKU
  // exists in the Marelvi feed and it already has an inventory level at the
  // dedicated Marelvi location. This keeps other supplier products out of both
  // price and stock writes.
  while (hasNextPage && processedCount < maxVariants) {
    const first = Math.min(250, maxVariants - processedCount);
    const data = await graphql<{
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyVariant[];
      };
    }>(
      "query MarelviShopifyFirst($first: Int!, $after: String, $locationId: ID!) { productVariants(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id sku barcode price compareAtPrice product { id } inventoryItem { id tracked inventoryLevel(locationId: $locationId) { quantities(names: [\"available\"]) { name quantity } } } } } }",
      { first, after: cursor, locationId },
    );

    for (const variant of data.productVariants.nodes) {
      processedCount += 1;
      const sku = variant.sku?.trim();
      if (!sku || variant.inventoryItem.inventoryLevel === null) continue;
      const supplier = feedBySku.get(sku);
      if (!supplier) {
        unmatchedLocationSkuCount += 1;
        continue;
      }
      if (supplier.ean && variant.barcode && supplier.ean.trim() !== variant.barcode.trim()) {
        identityMismatchCount += 1;
        continue;
      }
      candidatesBySku.set(sku, variant);
    }

    hasNextPage = data.productVariants.pageInfo.hasNextPage;
    cursor = hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  }

  const candidateProducts = Array.from(candidatesBySku.keys())
    .map((sku) => feedBySku.get(sku))
    .filter((product): product is MarelviProduct => product !== undefined);

  // Re-query candidate SKUs across the full Shopify catalog before writing.
  // Duplicate SKUs remain ambiguous and are skipped even when duplicates fall
  // on different pagination pages.
  const exactMatches = await findVariantsBySku(candidateProducts, locationId);
  const pageVariantIds = new Map(
    Array.from(candidatesBySku.entries()).map(([sku, variant]) => [sku, variant.id]),
  );
  const matches = exactMatches.matches.filter((match) =>
    pageVariantIds.get(match.supplier.sku) === match.variant.id && match.inventoryLevelActive,
  );
  const matchedSkus = new Set(matches.map((match) => match.supplier.sku));
  const ambiguousSkus = exactMatches.ambiguousSkus;
  const unmatchedCount =
    unmatchedLocationSkuCount +
    identityMismatchCount +
    exactMatches.unmatchedSkus.length +
    candidateProducts.filter((product) => !matchedSkus.has(product.sku) && !ambiguousSkus.includes(product.sku)).length;

  return {
    matches,
    ambiguousSkus,
    unmatchedCount,
    unmatchedLocationSkuCount,
    identityMismatchCount,
    processedCount,
    nextCursor: cursor,
    cycleComplete: !hasNextPage,
  };
}

export async function writeShopifyUpdates(matches: MatchedVariant[], locationId: string, runId: string): Promise<{ priceUpdated: number; stockUpdated: number; skippedStock: number }> {
  let priceUpdated = 0;
  let stockUpdated = 0;
  let skippedStock = 0;
  const byProduct = new Map<string, MatchedVariant[]>();
  for (const match of matches.filter((item) => item.needsPriceSync && item.supplier.price !== null && item.supplier.compareAtPrice !== null)) {
    const list = byProduct.get(match.variant.product.id) ?? [];
    list.push(match);
    byProduct.set(match.variant.product.id, list);
  }

  for (const [productId, group] of byProduct) {
    const data = await graphql<{ productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } }>(
      `mutation UpdateMarelviPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
      }`,
      { productId, variants: group.map(({ variant, supplier }) => ({ id: variant.id, price: supplier.price!.toFixed(2), compareAtPrice: supplier.compareAtPrice!.toFixed(2) })) },
    );
    if (data.productVariantsBulkUpdate.userErrors.length) throw new Error("SHOPIFY_PRICE_UPDATE_USER_ERROR");
    priceUpdated += group.length;
  }

  const stockCandidates = matches.filter((match) => match.needsStockSync);
  const quantityMatches = stockCandidates.filter((match) => match.inventoryTracked && match.inventoryLevelActive && match.currentAvailable !== null);
  skippedStock = stockCandidates.length - quantityMatches.length;
  for (let start = 0; start < quantityMatches.length; start += 100) {
    const batch = quantityMatches.slice(start, start + 100);
    const idempotencyKey = randomUUID();
    const data = await graphql<{ inventorySetQuantities: { userErrors: Array<{ message: string }> } }>(
      `mutation SetMarelviQuantities($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { message } }
      }`,
      {
        key: idempotencyKey,
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `marelvi://sync/${runId}/${idempotencyKey}`,
          quantities: batch.map(({ variant, supplier, currentAvailable }) => ({
            inventoryItemId: variant.inventoryItem.id,
            locationId,
            quantity: supplier.stock,
            changeFromQuantity: currentAvailable,
          })),
        },
      },
    );
    if (data.inventorySetQuantities.userErrors.length) throw new Error("SHOPIFY_INVENTORY_UPDATE_USER_ERROR");
    stockUpdated += batch.length;
  }
  return { priceUpdated, stockUpdated, skippedStock };
}
