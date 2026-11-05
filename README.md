# Carpatik – Marelvi Integration

Standalone scheduled integration for Marelvi → Shopify Carpatik (`veprzg-ph.myshopify.com`). It uses the supplier `rss.channel.item[]` JSON feed, Prisma/PostgreSQL for sync state, and Shopify Admin GraphQL API.

## Business rules

- Shopify is the traversal source: process existing Shopify variants in cursor-based batches, then match each SKU against the current Marelvi feed. No product creation.
- A variant is eligible for either price or stock updates only when its SKU exists in the Marelvi feed, it has a unique Shopify SKU match, and it already has an active inventory level at `Rudeni Marelvi depozit`. If both Marelvi EAN and Shopify barcode exist, they must also match. Products that fail any identity check are left unchanged.
- Shopify variants at the Marelvi location whose SKU is absent from the feed are counted for visibility but left unchanged. Supplier feed items without a matching eligible Shopify variant are also left unchanged.
- Selling price is Marelvi `pret_net` × 1.20. The Marelvi B2B price already includes VAT and the green fee; do not add `taxa_verde_net` or VAT again. Confirmed against AH611, displayed at 214.55 lei with VAT and green fee selected.
- Artificial compare-at price is 10% above calculated selling price.
- Availability mapping: `In stoc` → 10; `Stoc limitat` → 5; `La comanda` / `Comanda speciala` → 0.
- Inventory is queried and written only at the existing `Rudeni Marelvi depozit` location. Products without an active level there are not eligible for either price or stock updates; untracked items are skipped for stock. The sync does not change tracking or activate inventory.
- Missing Marelvi items never cause Shopify stock to be set to zero. Product status and other locations are not changed.
- Live writes are disabled unless `MARELVI_LIVE_SYNC_ENABLED=true`. Keep it false through dry-run review and enable only after explicit approval.

## Required Vercel environment variables

Set secrets in Vercel Project → Settings → Environment Variables; never put feed URLs, credentials, or `CRON_SECRET` in Git.

- `DATABASE_URL`: PostgreSQL connection string supplied by the Prisma Postgres integration connected to this Vercel project.
- `MARELVI_FEED_URL`: private HTTPS JSON feed URL from the Marelvi B2B account. The URL is not emitted to logs.
- `SHOPIFY_SHOP_DOMAIN`: `veprzg-ph.myshopify.com`.
- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`: Shopify Dev Dashboard app credentials with the required Admin API scopes.
- `SHOPIFY_INVENTORY_LOCATION_NAME`: `Rudeni Marelvi depozit` (must exist; no other location is used).
- `CRON_SECRET`: long random secret used to protect the cron endpoint.
- `MARELVI_LIVE_SYNC_ENABLED`: `false` initially; leave disabled until dry-run results are reviewed.

## Deployment and database

1. Install dependencies and run `npm run build`.
2. Connect a Prisma Postgres database to this Vercel project so `DATABASE_URL` is available in Production.
3. The deployment build runs `prisma migrate deploy` before compiling the app. The migration only creates the three `Marelvi*` tables used by this integration.
4. Add the remaining secret environment variables in Vercel and deploy.
5. Verify `/api/health`, then invoke `/api/cron/marelvi-sync` with `Authorization: Bearer <CRON_SECRET>` for a dry-run. Vercel Cron also sends this header when `CRON_SECRET` is configured.

The cron runs five minutes after the NOD schedule and processes up to 1,000 Shopify variants per invocation. The opaque Shopify pagination cursor, lock state, and run summaries are persisted in PostgreSQL. Shopify writes use only feed-matched variants already assigned to the dedicated Marelvi location and use inventory compare-and-swap values. Errors store safe codes only; API response bodies and the feed URL are not logged.

## Local checks

```sh
npm test
npm run build
```
