import assert from "node:assert/strict";
import test from "node:test";
import { mapMarelviProduct, parseMarelviFeed, stockFromAvailability } from "../lib/marelvi";

const base = {
  cod: "SKU-1",
  denumire: "Produs test",
  brand: "Beko",
  ean: "1234567890123",
  disponibilitate_stoc: "In stoc",
  pret_net: "1180.56",
  taxa_verde_net: "15.00",
};

test("adaugă taxa verde, TVA-ul și adaosul Carpatik în prețul Marelvi", () => {
  const product = mapMarelviProduct(base);
  assert.equal(product.price, 1735.95);
  assert.equal(product.compareAtPrice, 1909.54);
  assert.equal(product.stock, 10);
});

test("mapează toate valorile de disponibilitate Marelvi", () => {
  assert.equal(stockFromAvailability("In stoc"), 10);
  assert.equal(stockFromAvailability("Stoc limitat"), 5);
  assert.equal(stockFromAvailability("La comanda"), 0);
  assert.equal(stockFromAvailability("Comanda speciala"), 0);
});

test("respinge statusurile necunoscute și produsele fără preț valid", () => {
  assert.throws(() => stockFromAvailability(" indisponibil "), /Status de disponibilitate/);
  const zeroPrice = mapMarelviProduct({ ...base, pret_net: "0", taxa_verde_net: "0" });
  assert.equal(zeroPrice.price, null);
  assert.equal(zeroPrice.stock, 10);
});

test("citește structura RSS JSON și respinge SKU-uri duplicate", () => {
  const products = parseMarelviFeed({ rss: { channel: { item: [base] } } });
  assert.equal(products.length, 1);
  assert.equal(products[0].sku, "SKU-1");
  assert.throws(() => parseMarelviFeed({ rss: { channel: { item: [base, base] } } }), /SKU duplicat/);
});
