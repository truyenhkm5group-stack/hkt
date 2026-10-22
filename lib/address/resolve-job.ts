/**
 * ═══════════ MÁY ÁNH XẠ ĐỊA CHỈ NỀN — MỘT LƯỢT CỦA MỘT TỔ CHỨC (address-resolver-ladder PR-B · chủ shop chốt 22/10/2026) ═══════════
 *
 * Chạy KÉ job `sales-followup` (fan-out 5 phút) — KHÔNG BAO GIỜ trên đường trả lời khách: lượt chat đã trả lời xong, đơn đã chốt với
 * khách; ở đây chỉ đọc đơn bot còn dòng cờ máy «địa chỉ chưa ghép» mà có chữ địa chỉ nguyên văn (`raw.addressText`) chưa xét, chạy thang
 * `resolveAddress` (lib/address/resolver.ts) rồi ghi kết quả qua lõi đơn (`applyAddressResolutionAsAgent`): CHẮC ⇒ điền tỉnh / xã + gỡ cờ;
 * không chắc ⇒ ứng viên + lý do vào dòng cờ cho nhân viên. Vận đơn tự động vẫn giữ đơn còn cờ (ADDRESS_REVIEW) — chỗ DUY NHẤT xác minh
 * được giữ đơn.
 *  · Bậc Google Places dùng kết nối `google-places` CỦA CHÍNH tổ chức (không khoá nền tảng), mặc định BẬT khi kết nối đang hoạt động,
 *    tắt bằng settings `address.resolver` {"places": false}. Trần lượt / ngày RIÊNG (không ăn ngân sách Săn khách sỉ), đếm ở
 *    `address.resolver.usage`. Lỗi xác thực / hạn mức ⇒ ghi rõ, tắt Google cho phần còn lại của lượt, lùi về bậc (a)(b) + nhân viên.
 *  · Chỉ lưu tên xã / tỉnh của DANH MỤC ERP — không chép chữ / toạ độ Google lên đơn (điều khoản Google: dữ liệu ≤ 30 ngày).
 *  · Không ném: lỗi trả về trong kết quả, job khác vẫn chạy.
 *  · CÔNG TẮC theo tổ chức, không cần deploy (Tech Lead 22/10/2026): `address.resolver` {"enabled": false} ⇒ cả máy ánh xạ dừng ngay lượt
 *    kế (không đọc đơn, không ghi gì); `perTick` = trần số đơn MỘT lượt (mặc định 15, tối đa 50). Lượt nào cũng CHỈ chạm đơn mang dòng cờ
 *    MÁY «địa chỉ chưa ghép» (tiền tố `MACHINE_ADDRESS_NOTE_PREFIX`) — cờ người gắn không bao giờ bị máy đụng.
 *  · PHẠM VI (Tech Lead 22/10/2026 — đây là ghi lên đơn đã có): chỉ đơn ở stage đơn tay còn sửa được (`MANUAL_ORDER_STAGES` — không huỷ,
 *    không «đã giao» / «giao không thành công»), KHÔNG có vận đơn chưa huỷ, tạo trong `ADDRESS_RESOLVER_SCOPE.maxAgeDays` ngày. Lọc ngay ở
 *    câu chọn (đơn ngoài phạm vi không chiếm chỗ của lượt) VÀ kiểm lại trong giao dịch ghi (`applyAddressResolutionAsAgent` — vận đơn tạo
 *    giữa hai bước). Đơn ngoài phạm vi KHÔNG bị ghi gì; số còn treo cờ đếm theo lý do (`countOutOfScope`) ở trạng thái ngày 2B.
 *  · Đơn chốt TRƯỚC khi có `raw.addressText` (đơn của bản #966): máy đọc lại tin CỦA KHÁCH trong hội thoại, từ 3 ngày trước tới lúc đơn
 *    tạo, qua đúng bộ lọc dòng địa chỉ của lượt chat (`addressTextLines`) — KHÔNG dùng dòng địa chỉ model chép lên đơn (xã chỉ ghi khi
 *    khách nói). Vết `raw.addressResolution.textSource` nói chữ lấy từ đâu.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { resolveAddress, type ResolverVerdict } from "@/lib/address/resolver";
import { MANUAL_ORDER_STAGES } from "@/lib/constants/manual-orders";
import { MACHINE_ADDRESS_NOTE_PREFIX, orderReviewOf } from "@/lib/constants/order-review";
import { openActiveConnection } from "@/lib/connectors/service";
import { placesRelayOf, textSearch, type PlacesClientDeps } from "@/lib/integrations/google-places/client";
import { applyAddressResolutionAsAgent, type AddressResolution, type OrderAgent } from "@/lib/records/order-create";
import { addressQueryText, addressTextLines } from "@/lib/sales-chatbot/address-memory";
import { loadCustomer360 } from "@/lib/sales-chatbot/customer-360";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { DEFAULT_LEAD_HUNTER_CONFIG, skuCostMicros } from "@/lib/wholesale/config";

export const ADDRESS_RESOLVER_AGENT: OrderAgent = { name: "Máy ánh xạ địa chỉ", source: "lib/address/resolve-job.ts" };
/**
 * Cấu hình theo tổ chức (OBJECT — luật cờ settings): `enabled` = công tắc cả máy (vắng ⇒ BẬT; `false` ⇒ dừng, không cần deploy) ·
 * `places` = bậc Google (vắng ⇒ BẬT khi kết nối hoạt động) · `dailyPlacesLimit` · `perTick`.
 */
export const ADDRESS_RESOLVER_SETTING_KEY = "address.resolver";
/** Sổ đếm lượt Google trong ngày giờ Việt Nam + lỗi gần nhất (2B đọc để in). */
export const ADDRESS_RESOLVER_USAGE_KEY = "address.resolver.usage";
/**
 * `dailyPlacesLimit` 100 lượt / ngày / tổ chức (≈ 3,2 USD theo giá Text Search Pro 32 USD / 1.000 lượt) — ĐỀ XUẤT ban đầu, ghi đè ở
 * `address.resolver`. `perTick` · `tickBudgetMs` giữ một lượt job ngắn; `maxAttempts` = số lượt xét lại cùng một chữ địa chỉ.
 */
export const ADDRESS_RESOLVER_DEFAULTS = { dailyPlacesLimit: 100, perTick: 15, maxPerTick: 50, placesTimeoutMs: 8_000, tickBudgetMs: 25_000, maxAttempts: 3 } as const;
/** Đơn chốt trước khi có `raw.addressText`: đọc tin khách trong cửa sổ này trước lúc đơn tạo (bằng hạn lượt mua của bot — 3 ngày). */
export const LEGACY_TEXT_WINDOW_MS = 3 * 24 * 3_600_000;
/** Phạm vi đơn máy được ghi: tuổi đơn tối đa (ngày, theo `orders.created_at`). */
export const ADDRESS_RESOLVER_SCOPE = { maxAgeDays: 14 } as const;
/** Lý do một đơn còn treo cờ máy nằm NGOÀI phạm vi: huỷ / xoá · đã khép (giao / giao không thành công) · có vận đơn chưa huỷ · quá tuổi. */
export const OUT_OF_SCOPE_REASONS = ["CANCELLED", "CLOSED", "SHIPMENT", "TOO_OLD"] as const;
export type OutOfScopeReason = (typeof OUT_OF_SCOPE_REASONS)[number];

const scopeCutoff = (now: Date) => new Date(now.getTime() - ADDRESS_RESOLVER_SCOPE.maxAgeDays * 24 * 3_600_000);
/**
 * Đơn có vận đơn CHƯA HUỶ (stage). Câu con tương quan viết tên bảng ngoài TƯỜNG MINH: trong truy vấn một bảng drizzle in `${o.id}` thành
 * `"id"` trần và câu con hiểu là id của vận đơn — điều kiện sai im lặng. Chặt hơn `attemptHoldsOrder` (vận đơn hãng báo huỷ mà stage chưa
 * về CANCELLED vẫn tính là có) — sai về phía KHÔNG ghi.
 */
const activeShipmentSql = sql`exists (select 1 from "shipments" s where s.order_id = "orders"."id" and s.stage::text <> 'CANCELLED')`;
/** Dòng cờ MÁY «địa chỉ chưa ghép» còn mở (cờ người gắn không tính). */
const machineFlagSql = sql`exists (select 1 from jsonb_array_elements(coalesce("orders"."raw"->'review'->'entries', '[]'::jsonb)) e where e->>'code' = 'ADDRESS_UNRESOLVED' and starts_with(e->>'note', ${MACHINE_ADDRESS_NOTE_PREFIX}))`;

/** Số đơn bot còn treo cờ máy «địa chỉ chưa ghép» mà máy KHÔNG được chạm, theo lý do (lý do đầu tiên khớp). Không ghi gì. */
export async function countOutOfScope(now: Date): Promise<Record<OutOfScopeReason, number>> {
  const db = await getDb();
  const o = schema.orders;
  const stages = sql.join(MANUAL_ORDER_STAGES.map((s) => sql`${s}`), sql`, `);
  const reason = sql<string | null>`case when "orders"."stage"::text in ('CANCELLED', 'DELETED') then 'CANCELLED' when "orders"."stage"::text not in (${stages}) then 'CLOSED' when ${activeShipmentSql} then 'SHIPMENT' when "orders"."created_at" < ${scopeCutoff(now).toISOString()}::timestamptz then 'TOO_OLD' else null end`;
  const rows = await db
    .select({ reason, n: sql<number>`count(*)::int` })
    .from(o)
    .where(and(sql`${o.salesConversationId} is not null`, eq(o.shipCommune, ""), machineFlagSql))
    .groupBy(sql`1`);
  const out: Record<OutOfScopeReason, number> = { CANCELLED: 0, CLOSED: 0, SHIPMENT: 0, TOO_OLD: 0 };
  for (const r of rows) if (r.reason && (OUT_OF_SCOPE_REASONS as readonly string[]).includes(r.reason)) out[r.reason as OutOfScopeReason] += Number(r.n);
  return out;
}

export type AddressResolverConfig = { enabled?: boolean; places?: boolean; dailyPlacesLimit?: number; perTick?: number };

export type AddressResolverUsage = { day: string; places: number; costMicros: number; lastError: string | null; lastErrorAt: string | null };
export type ResolvePendingResult = { checked: number; sure: number; unsure: number; none: number; placesCalls: number; placesOff: string | null; placesError: string | null; error: string | null; off: string | null };

const vnDay = (at: Date) => new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * Chỗ cắm cho bài kiểm (không gọi mạng thật): `openPlaces` thay việc mở kết nối, `textSearch` thay lời gọi Google, `callTimeoutMs` thay
 * trần mỗi lời gọi (treo / chậm ⇒ lỗi TIMEOUT, lượt đi tiếp).
 */
type Deps = { places?: PlacesClientDeps; textSearch?: typeof textSearch; openPlaces?: () => Promise<{ apiKey: string; relay: ReturnType<typeof placesRelayOf> } | { off: string }>; callTimeoutMs?: number; now?: () => number };

/** Trần thời gian cứng của MỘT lời gọi Google — kể cả khi tầng mạng không tự dừng. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("TIMEOUT"), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, () => {
      clearTimeout(t);
      resolve("TIMEOUT");
    });
  });
}

/** Một lượt. `now` là tham số (bài kiểm không đọc đồng hồ thật). Không ném. */
export async function resolvePendingAddresses(now: Date = new Date(), deps: Deps = {}): Promise<ResolvePendingResult> {
  const out: ResolvePendingResult = { checked: 0, sure: 0, unsure: 0, none: 0, placesCalls: 0, placesOff: null, placesError: null, error: null, off: null };
  const clock = deps.now ?? (() => Date.now());
  const started = clock();
  try {
    const cfg = await getSettingJson<AddressResolverConfig>(ADDRESS_RESOLVER_SETTING_KEY, {});
    if (cfg.enabled === false) return { ...out, off: "tắt ở address.resolver" };
    const perTick = Number.isInteger(cfg.perTick) && (cfg.perTick as number) >= 1 ? Math.min(cfg.perTick as number, ADDRESS_RESOLVER_DEFAULTS.maxPerTick) : ADDRESS_RESOLVER_DEFAULTS.perTick;
    const limit = Number.isInteger(cfg.dailyPlacesLimit) && (cfg.dailyPlacesLimit ?? -1) >= 0 ? (cfg.dailyPlacesLimit as number) : ADDRESS_RESOLVER_DEFAULTS.dailyPlacesLimit;
    const day = vnDay(now);
    const prev = await getSettingJson<Partial<AddressResolverUsage>>(ADDRESS_RESOLVER_USAGE_KEY, {});
    const usage: AddressResolverUsage = prev.day === day ? { day, places: prev.places ?? 0, costMicros: prev.costMicros ?? 0, lastError: prev.lastError ?? null, lastErrorAt: prev.lastErrorAt ?? null } : { day, places: 0, costMicros: 0, lastError: null, lastErrorAt: null };

    const db = await getDb();
    const o = schema.orders;
    const rows = await db
      .select({ id: o.id, raw: o.raw, address: o.shipAddress, province: o.shipProvince, conv: o.salesConversationId, createdAt: o.createdAt })
      .from(o)
      .where(
        and(
          sql`${o.salesConversationId} is not null`,
          inArray(o.stage, [...MANUAL_ORDER_STAGES]),
          gte(o.createdAt, scopeCutoff(now)),
          sql`not ${activeShipmentSql}`,
          eq(o.shipCommune, ""),
          sql`${o.raw}->'review'->'entries' @> '[{"code":"ADDRESS_UNRESOLVED"}]'::jsonb`,
          sql`(${o.raw}->'addressResolution' is null or (${o.raw}->'addressResolution'->>'textAt') is distinct from (${o.raw}->'addressText'->>'at') or coalesce((${o.raw}->'addressResolution'->>'attempts')::int, 0) < ${ADDRESS_RESOLVER_DEFAULTS.maxAttempts} and (${o.raw}->'addressResolution'->>'places') = 'false')`,
        ),
      )
      .orderBy(desc(o.updatedAt))
      .limit(perTick);
    if (!rows.length) return out;

    // Bậc Google: mở kết nối MỘT lần / lượt.
    let places: { apiKey: string; relay: ReturnType<typeof placesRelayOf> } | null = null;
    if (cfg.places === false) out.placesOff = "tắt ở address.resolver";
    else if (usage.places >= limit) out.placesOff = `hết trần ${limit} lượt Google hôm nay`;
    else {
      const opened = deps.openPlaces ? await deps.openPlaces().catch(() => ({ off: "lỗi mở kết nối" })) : await openPlacesConnection();
      if ("off" in opened) out.placesOff = opened.off;
      else places = opened;
    }
    const search = deps.textSearch ?? textSearch;
    const micros = skuCostMicros("TEXT_SEARCH_PRO", DEFAULT_LEAD_HUNTER_CONFIG);

    for (const r of rows) {
      if (clock() - started > ADDRESS_RESOLVER_DEFAULTS.tickBudgetMs) break;
      const raw = (r.raw ?? {}) as { addressText?: { lines?: unknown; at?: unknown }; addressResolution?: Partial<AddressResolution> };
      if (!orderReviewOf(r.raw)?.entries.some((e) => e.code === "ADDRESS_UNRESOLVED" && e.note.startsWith(MACHINE_ADDRESS_NOTE_PREFIX))) continue;
      const stored = Array.isArray(raw.addressText?.lines) ? (raw.addressText!.lines as unknown[]).filter((x): x is string => typeof x === "string") : null;
      const lines = stored ?? (r.conv ? await conversationAddressLines(r.conv, r.createdAt).catch(() => []) : []);
      const textSource: AddressResolution["textSource"] = stored ? "ORDER_TEXT" : lines.length ? "CONVERSATION" : "NONE";
      const textAt = typeof raw.addressText?.at === "string" ? raw.addressText.at : null;
      const attempts = raw.addressResolution?.textAt === textAt ? (raw.addressResolution?.attempts ?? 0) + 1 : 1;
      out.checked += 1;
      const recipient = { address: r.address, province: r.province };
      const verified = r.conv ? await verifiedOf(r.conv).catch(() => []) : [];
      let v: ResolverVerdict = resolveAddress({ lines, recipient, verified, places: null });
      let usedPlaces = false;
      let placesError: string | null = null;
      // Chỉ VẾ địa chỉ đi ra Google — không tên, không món, không SĐT (chính sách riêng tư 1.3 mục 6).
      const query = addressQueryText(lines.length ? lines : [r.address]);
      if (v.status !== "SURE" && places && usage.places < limit && query) {
        const timeoutMs = deps.callTimeoutMs ?? ADDRESS_RESOLVER_DEFAULTS.placesTimeoutMs;
        const raced = await withTimeout(search({ apiKey: places.apiKey, timeoutMs, maxRetries: 1, relay: places.relay }, { textQuery: query, tier: "PRO" }, deps.places), timeoutMs + 500);
        const res = raced === "TIMEOUT" ? { ok: false as const, kind: "TIMEOUT" as const, message: `quá ${timeoutMs} ms`, meta: null } : raced;
        usedPlaces = true;
        out.placesCalls += 1;
        usage.places += 1;
        if (res.ok) {
          usage.costMicros += micros;
          v = resolveAddress({ lines, recipient, verified, places: res.places.slice(0, 5).map((p) => p.address) });
        } else {
          placesError = `${res.kind}: ${String(res.message).slice(0, 120)}`;
          out.placesError = placesError;
          usage.lastError = placesError;
          usage.lastErrorAt = now.toISOString();
          // Khoá bị từ chối / hết hạn mức ⇒ không gọi tiếp trong lượt này (lùi về bậc a/b + nhân viên).
          if (res.kind === "AUTH" || res.kind === "QUOTA") places = null;
        }
      }
      const resolution: AddressResolution = {
        status: v.status,
        source: v.source,
        ward: v.pick?.ward ?? null,
        province: v.pick?.province ?? null,
        candidates: v.candidates.map((c) => c.ward).slice(0, 6),
        reason: placesError ? `${v.reason} · Google lỗi ${placesError}` : v.reason,
        textAt,
        textSource,
        places: usedPlaces,
        placesError,
        attempts,
        at: now.toISOString(),
      };
      await applyAddressResolutionAsAgent(ADDRESS_RESOLVER_AGENT, r.id, r.address, resolution, now);
      if (v.status === "SURE") out.sure += 1;
      else if (v.status === "UNSURE") out.unsure += 1;
      else out.none += 1;
    }
    await setSettingJson(ADDRESS_RESOLVER_USAGE_KEY, usage);
    return out;
  } catch (e) {
    return { ...out, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

/** Mở kết nối `google-places` ĐANG HOẠT ĐỘNG của tổ chức ngữ cảnh; không có / hỏng ⇒ lý do tắt bậc Google. Không ném. */
async function openPlacesConnection(): Promise<{ apiKey: string; relay: ReturnType<typeof placesRelayOf> } | { off: string }> {
  const conn = await openActiveConnection("google-places").catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : "lỗi mở kết nối" }));
  if (conn.ok && conn.secrets.apiKey) return { apiKey: conn.secrets.apiKey, relay: placesRelayOf(conn.settings, conn.secrets) };
  return { off: conn.ok ? "kết nối google-places thiếu khoá" : conn.reason.slice(0, 160) };
}

/**
 * Đơn chốt trước khi có `raw.addressText`: các dòng mang địa chỉ trong tin CỦA KHÁCH (vai `user`, chỉ khối chữ) từ
 * `LEGACY_TEXT_WINDOW_MS` trước tới lúc đơn tạo — tin gửi SAU khi đơn tạo không thuộc đơn này.
 */
export async function conversationAddressLines(conversationId: string, orderAt: Date): Promise<string[]> {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const msgs = await db
    .select({ content: m.content })
    .from(m)
    .where(and(eq(m.conversationId, conversationId), eq(m.role, "user"), gte(m.createdAt, new Date(orderAt.getTime() - LEGACY_TEXT_WINDOW_MS)), lte(m.createdAt, orderAt)))
    .orderBy(asc(m.seq));
  const texts = msgs.map((x) => (Array.isArray(x.content) ? (x.content as { type?: unknown; text?: unknown }[]).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("\n").trim() : "")).filter(Boolean);
  return addressTextLines(texts);
}

/** Địa chỉ ĐÃ XÁC MINH của chính khách (Customer 360, cùng tổ chức) cho bậc (b). */
async function verifiedOf(conversationId: string): Promise<{ address: string; province: string; ward: string }[]> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ id: c.id, pageId: c.pageId, threadId: c.threadId, state: c.state }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv) return [];
  const view = await loadCustomer360({ conversationId: conv.id, pageId: conv.pageId, threadId: conv.threadId, state: (conv.state ?? {}) as ChatState });
  return view.masked ? [] : view.addresses.map((a) => ({ address: a.address, province: a.province, ward: a.ward }));
}

/** Dòng tóm tắt cho `sync_runs` (chỉ số đếm). HÀM THUẦN. */
export function resolvePendingSummary(r: ResolvePendingResult): string {
  if (r.error) return ` · ánh xạ địa chỉ lỗi: ${r.error}`;
  if (r.off) return ` · ánh xạ địa chỉ: ${r.off}`;
  if (!r.checked) return "";
  return ` · ánh xạ địa chỉ: ${r.checked} đơn (chắc ${r.sure} · cần nhân viên ${r.unsure + r.none}) · Google ${r.placesCalls}${r.placesOff ? ` (tắt: ${r.placesOff})` : ""}${r.placesError ? ` · Google lỗi ${r.placesError}` : ""}`;
}
