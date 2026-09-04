import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { asRecord, int, parseJsonSafeInts, str } from "@/lib/integrations/http";
import { mapCustomer, mapOrder, mapProduct, mapVariant } from "@/lib/integrations/pancake/mapper";
import { syncOrderById, upsertCustomer, upsertOrder, upsertProduct, upsertVariant } from "@/lib/integrations/pancake/sync";
import { publish } from "@/lib/realtime/bus";

export type PancakeWebhookKind = "orders" | "customers" | "products" | "variations_warehouses" | "unknown";

export function detectKind(payload: Record<string, unknown>, pathHint: string): PancakeWebhookKind {
  const type = str(payload.type, payload.event_type, payload.event).toLowerCase();
  const hint = pathHint.toLowerCase();
  if (type.includes("variations_warehouses") || hint.includes("stock") || hint.includes("variations_warehouses")) return "variations_warehouses";
  if (type.includes("order") || hint.includes("order")) return "orders";
  if (type.includes("customer") || hint.includes("customer")) return "customers";
  if (type.includes("product") || hint.includes("product")) return "products";
  if (payload.items !== undefined && payload.bill_phone_number !== undefined) return "orders";
  if (payload.variation_id !== undefined && payload.remain_quantity !== undefined) return "variations_warehouses";
  if (payload.variations !== undefined) return "products";
  if (payload.phone_numbers !== undefined) return "customers";
  return "unknown";
}

export function parseWebhookBody(text: string): Record<string, unknown> {
  const parsed = parseJsonSafeInts(text);
  const record = asRecord(parsed);
  if (record.order && typeof record.order === "object") return { ...asRecord(record.order), type: str(record.type, "orders") };
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data) && record.items === undefined) {
    return { ...asRecord(record.data), type: str(record.type, asRecord(record.data).type) };
  }
  return record;
}

/** Lưu webhook vào hộp thư đến; trả về id để xử lý nền */
export async function storeWebhook(source: "PANCAKE" | "VIETTELPOST", eventType: string, externalId: string | null, payload: unknown, headers: Record<string, string>) {
  const db = await getDb();
  const [row] = await db.insert(schema.webhookEvents).values({ source, eventType, externalId, payload, headers }).returning({ id: schema.webhookEvents.id });
  return row.id;
}

export async function markWebhook(id: string, status: "PROCESSED" | "FAILED" | "IGNORED", error?: string | null) {
  const db = await getDb();
  await db
    .update(schema.webhookEvents)
    .set({ status, processedAt: new Date(), error: error ? error.slice(0, 2000) : null })
    .where(eq(schema.webhookEvents.id, id));
}

export async function processPancakeWebhook(eventId: string) {
  const db = await getDb();
  const event = await db.query.webhookEvents.findFirst({ where: eq(schema.webhookEvents.id, eventId) });
  if (!event || event.status === "PROCESSED") return;
  const payload = asRecord(event.payload);
  const kind = event.eventType as PancakeWebhookKind;
  try {
    let result = "ignored";
    let note: string | null = null;
    if (kind === "orders") {
      const id = str(payload.id, payload.system_id);
      if (id) {
        try {
          result = await syncOrderById(id, { force: false });
        } catch (error) {
          note = `Không tải lại được từ API (${error instanceof Error ? error.message : String(error)}), dùng dữ liệu webhook`;
          const mapped = mapOrder(payload);
          if (mapped) result = await upsertOrder(mapped, { force: false, source: "webhook" });
        }
      }
    } else if (kind === "customers") {
      const mapped = mapCustomer(payload);
      if (mapped) {
        await upsertCustomer(mapped, db);
        result = "updated";
      }
    } else if (kind === "products") {
      const mapped = mapProduct(payload);
      if (mapped && mapped.variants.length) {
        await upsertProduct(mapped, db);
        result = "updated";
      } else {
        const variant = mapVariant(payload);
        if (variant) {
          await upsertVariant(variant, db);
          result = "updated";
        } else if (mapped) {
          await upsertProduct(mapped, db);
          result = "updated";
        }
      }
    } else if (kind === "variations_warehouses") {
      const variantId = str(payload.variation_id);
      const warehouseId = str(payload.warehouse_id);
      if (variantId && warehouseId) {
        const variant = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.id, variantId), columns: { id: true } });
        if (variant) {
          await db.insert(schema.warehouses).values({ id: warehouseId, name: "Kho" }).onConflictDoNothing();
          const stock = { remainQuantity: int(payload.remain_quantity), actualRemainQuantity: int(payload.actual_remain_quantity) };
          await db
            .insert(schema.variantStocks)
            .values({ variantId, warehouseId, ...stock })
            .onConflictDoUpdate({ target: [schema.variantStocks.variantId, schema.variantStocks.warehouseId], set: { ...stock, updatedAt: new Date() } });
          const [totals] = await db
            .select({ remain: sql<number>`coalesce(sum(${schema.variantStocks.remainQuantity}), 0)`, actual: sql<number>`coalesce(sum(${schema.variantStocks.actualRemainQuantity}), 0)` })
            .from(schema.variantStocks)
            .where(eq(schema.variantStocks.variantId, variantId));
          await db
            .update(schema.productVariants)
            .set({ remainQuantity: Number(totals.remain), actualRemainQuantity: Number(totals.actual), syncedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.productVariants.id, variantId));
          publish({ type: "stock", variantId });
          result = "updated";
        } else {
          result = "ignored";
          note = "Chưa có mẫu mã này trong ERP — hãy đồng bộ sản phẩm";
        }
      }
    }
    await markWebhook(eventId, result === "ignored" ? "IGNORED" : "PROCESSED", note);
  } catch (error) {
    await markWebhook(eventId, "FAILED", error instanceof Error ? error.message : String(error));
  }
}
