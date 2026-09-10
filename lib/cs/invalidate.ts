import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_NOT_CREATED_RULE_VERSION } from "@/lib/constants/cs";

/**
 * ═══════════ ĐÓNG MỀM CASE SINH BỞI LUẬT ĐÃ SAI ═══════════
 *
 * Ngày 10/09/2026 luật phát hiện "đủ thông tin · chưa tạo đơn" đổi từ v1 sang v2: v1 tìm từ khoá
 * "chốt đơn" trong tin của SHOP (sai — kịch bản bán hàng chứa sẵn chữ đó), v2 đòi KHÁCH đã cho đủ
 * SĐT và địa chỉ. 180 case sinh bởi v1 không còn đúng.
 *
 * ─── VÌ SAO KHÔNG XOÁ ───
 *
 * Bảng case có vòng đời trạng thái và mốc `resolved_at`. Xoá cứng thì sáu tháng sau không ai trả
 * lời được "180 case đó đi đâu, ai quyết, vì sao" — và đó chính là loại câu hỏi mà một hệ vận hành
 * phải trả lời được. Nên đóng MỀM: giữ nguyên dòng, ghi rõ vì sao đóng và luật nào thay luật nào.
 *
 * ─── VÌ SAO KHÔNG DÙNG `DONE` ───
 *
 * `DONE` là công của người: có ai đó ngồi xử lý xong. Đóng 180 case sai luật mà ghi `DONE` sẽ làm
 * bảng năng suất CSKH trông như 180 lần có người gọi khách. `AUTO_RESOLVED` nói đúng sự thật:
 * không ai làm gì cả, chỉ là luật đã đổi.
 *
 * ─── KHÔNG ĐỤNG CASE CÓ NGƯỜI CHẠM VÀO ───
 *
 * Chỉ đóng case thoả ĐỦ: máy tạo · sinh bởi luật cũ · đang mở · chưa ai nhận · chưa ai ghi kết
 * luận. Case có người nhận hoặc đã ghi gì đó thì để nguyên cho người xem lại — máy không được
 * quyết thay.
 */

/** Dấu vân tay của luật v1 trong nội dung case: câu mở đầu do chính nó sinh ra. */
const DAU_VET_LUAT_CU = "Shop đã chốt trong chat";

export type InvalidateResult = {
  /** Case đang mở của loại này TRƯỚC khi đóng. */
  openBefore: number;
  /** Đã đóng mềm vì luật đổi. */
  autoResolved: number;
  /** Có người nhận / có kết luận ⇒ GIỮ NGUYÊN, cần người xem lại. */
  humanTouched: number;
  /** Đang mở nhưng KHÔNG mang dấu vết luật cũ ⇒ không đụng tới. */
  notOldRule: number;
};

/**
 * Đóng mềm các case `ORDER_NOT_CREATED` sinh bởi luật cũ.
 *
 * `dryRun` mặc định TRUE: đếm và báo cáo, không ghi gì. Đổi dữ liệu production phải là một quyết
 * định tường minh, không phải tác dụng phụ của việc chạy một lệnh xem thử.
 */
export async function invalidateOldOrderNotCreatedCases(options: { dryRun?: boolean; actor?: string } = {}): Promise<InvalidateResult> {
  const dryRun = options.dryRun !== false;
  const db = await getDb();
  const c = schema.csCases;

  const dangMo = and(eq(c.kind, "ORDER_NOT_CREATED"), inArray(c.status, ["OPEN", "IN_PROGRESS"]));
  const luatCu = sql`${c.detail} like ${`${DAU_VET_LUAT_CU}%`}`;
  // "Chưa ai chạm vào" = chưa ai nhận VÀ chưa ai ghi kết luận. Hai điều kiện, không phải một.
  const chuaAiCham = and(or(isNull(c.assignee), eq(c.assignee, "")), eq(c.resolution, ""));

  const [dem] = await db
    .select({
      openBefore: sql<number>`count(*)`,
      luatCu: sql<number>`count(*) filter (where ${luatCu})`,
      dongDuoc: sql<number>`count(*) filter (where ${luatCu} and ${chuaAiCham})`,
      nguoiCham: sql<number>`count(*) filter (where ${luatCu} and not (${chuaAiCham}))`,
    })
    .from(c)
    .where(dangMo);

  const openBefore = Number(dem?.openBefore ?? 0);
  const ket: InvalidateResult = {
    openBefore,
    autoResolved: Number(dem?.dongDuoc ?? 0),
    humanTouched: Number(dem?.nguoiCham ?? 0),
    notOldRule: openBefore - Number(dem?.luatCu ?? 0),
  };
  if (dryRun || !ket.autoResolved) return ket;

  await db
    .update(c)
    .set({
      status: "AUTO_RESOLVED",
      // Giữ đủ dấu vết: vì sao đóng, luật nào thay luật nào, ai/cái gì quyết.
      resolution: `INVALIDATED_BY_RULE_UPDATE · luật v1 (từ khoá trong tin shop) → v${ORDER_NOT_CREATED_RULE_VERSION} (khách cho đủ SĐT + địa chỉ) · ${options.actor ?? "job:cs-rule-update"}`,
      resolvedAt: new Date(),
    })
    .where(and(dangMo, luatCu, chuaAiCham));

  return ket;
}
