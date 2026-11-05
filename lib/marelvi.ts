export type MarelviAvailability = "In stoc" | "Stoc limitat" | "La comanda" | "Comanda speciala";

export type MarelviProduct = {
  sku: string;
  title: string;
  brand: string;
  ean: string | null;
  availability: MarelviAvailability;
  netPrice: number;
  greenFeeNet: number;
  price: number | null;
  compareAtPrice: number | null;
  stock: 0 | 5 | 10;
  hash: string;
};

const STOCK_BY_AVAILABILITY: Record<MarelviAvailability, 0 | 5 | 10> = {
  "In stoc": 10,
  "Stoc limitat": 5,
  "La comanda": 0,
  "Comanda speciala": 0,
};

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseAmount(value: unknown, field: string, sku: string): number {
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const amount = Number(normalized);
  if (!normalized || !Number.isFinite(amount) || amount < 0) {
    throw new Error(`Valoare invalidă pentru ${field}, SKU ${sku}`);
  }
  return amount;
}

export function stockFromAvailability(value: unknown): 0 | 5 | 10 {
  const normalized = String(value ?? "").trim().toLocaleLowerCase("ro-RO");
  const match = (Object.keys(STOCK_BY_AVAILABILITY) as MarelviAvailability[]).find(
    (key) => key.toLocaleLowerCase("ro-RO") === normalized,
  );
  if (!match) throw new Error(`Status de disponibilitate Marelvi necunoscut: ${String(value)}`);
  return STOCK_BY_AVAILABILITY[match];
}

function stableHash(fields: Record<string, string | number | null>): string {
  // Small deterministic fingerprint; it is a change detector, not a security hash.
  const text = Object.keys(fields).sort().map((key) => `${key}:${fields[key] ?? ""}`).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function mapMarelviProduct(raw: Record<string, unknown>): MarelviProduct {
  const sku = String(raw.cod ?? "").trim();
  if (!sku) throw new Error("Produs Marelvi fără cod/SKU");

  const availability = String(raw.disponibilitate_stoc ?? "").trim() as MarelviAvailability;
  const stock = stockFromAvailability(availability);
  const netPrice = parseAmount(raw.pret_net, "pret_net", sku);
  const greenFeeNet = parseAmount(raw.taxa_verde_net, "taxa_verde_net", sku);
  if (netPrice < 0) throw new Error(`Preț net negativ pentru SKU ${sku}`);

  // Convert Marelvi net price plus green fee to its VAT-inclusive B2B price, round to cents, then add Carpatik's 20% markup.
  const marelviB2bPrice = money((netPrice + greenFeeNet) * 1.21);
  const price = marelviB2bPrice > 0 ? money(marelviB2bPrice * 1.2) : null;
  const compareAtPrice = price === null ? null : money(price * 1.1);
  const title = String(raw.denumire ?? "").trim();
  const brand = String(raw.brand ?? "").trim();
  const ean = String(raw.ean ?? "").trim() || null;

  return {
    sku,
    title,
    brand,
    ean,
    availability,
    netPrice,
    greenFeeNet,
    price,
    compareAtPrice,
    stock,
    hash: stableHash({ sku, netPrice, greenFeeNet, availability, price, compareAtPrice, stock }),
  };
}

export function parseMarelviFeed(json: unknown): MarelviProduct[] {
  if (!json || typeof json !== "object") throw new Error("Feed-ul Marelvi nu este un obiect JSON");
  const rss = (json as { rss?: { channel?: { item?: unknown } } }).rss;
  const rawItems = rss?.channel?.item;
  if (!Array.isArray(rawItems)) throw new Error("Feed-ul JSON nu conține rss.channel.item[]");

  const products: MarelviProduct[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Feed-ul conține un produs cu structură invalidă");
    }
    const product = mapMarelviProduct(item as Record<string, unknown>);
    if (seen.has(product.sku)) throw new Error(`SKU duplicat în feed: ${product.sku}`);
    seen.add(product.sku);
    products.push(product);
  }
  return products;
}
