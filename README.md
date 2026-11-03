# Carpatik – Marelvi Integration

Standalone scheduled integration for Marelvi → Shopify Carpatik (`veprzg-ph.myshopify.com`). It uses the supplier `rss.channel.item[]` JSON feed, Prisma/PostgreSQL for sync state, and Shopify Admin GraphQL API.

## Business rules

- Match `cod` to Shopify variant SKU. Existing products only; no product creation.
- Purchase price is Marelvi `pret_net` (the current B2B price) plus `taxa_verde_net`, then VAT 21% and 20% markup: `(pret_net + taxa_verde_net) × 1.21 × 1.20`.
- Artificial compare-at price is 10% above calculated selling price.
- Availability mapping: `In stoc` → 10; `Stoc limitat` → 5; `La comanda` / `Comanda speciala` → 0.
- Inventory is queried and written only at the existing `Rudeni Marelvi depozit` location. Products without tracking or an active inventory level there are reported and skipped for stock; the sync does not change tracking or activate inventory.
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

The cron runs every 15 minutes and processes up to 500 supplier products per invocation. Progress, lock state, and run summaries are persisted in PostgreSQL. Shopify writes use the dedicated location and inventory compare-and-swap values. Errors store safe codes only; API response bodies and the feed URL are not logged.

## Local checks

```sh
npm test
npm run build
```
