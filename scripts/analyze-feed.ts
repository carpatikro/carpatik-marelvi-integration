import fs from "node:fs";
import { parseMarelviFeed } from "../lib/marelvi";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run analyze:feed -- <products.json>");
  process.exit(2);
}

const products = parseMarelviFeed(JSON.parse(fs.readFileSync(filePath, "utf8")));
const availability: Record<string, number> = {};
for (const product of products) availability[product.availability] = (availability[product.availability] ?? 0) + 1;
const zeroPrice = products.filter((product) => product.price === null).map(({ sku }) => sku);
const missingEan = products.filter((product) => !product.ean).length;
console.log(JSON.stringify({
  productCount: products.length,
  availability,
  zeroPriceCount: zeroPrice.length,
  zeroPriceSkus: zeroPrice,
  missingEan,
}, null, 2));
