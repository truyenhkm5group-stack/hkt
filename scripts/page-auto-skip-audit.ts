/*
  ops `page-auto-skip-audit` — TIN KHÁCH BỊ CHỐT «PAGE ĐÃ TRẢ LỜI» MÀ KHÔNG CÓ CÂU TRẢ LỜI HỢP LỆ NÀO (CHỈ ĐỌC, MỘT TỔ CHỨC).

  Vì sao có (P0 HSLC 16/10/2026, issue #856 «Cao Hải Ninh»): khách bấm quảng cáo hỏi «Báo giá chả cá thu?», page tự gửi lời chào /
  creative cùng giây ⇒ tin khách bị chốt SKIPPED «Page đã trả lời», AI không báo giá. Gốc: `answers()` coi tin TỰ ĐỘNG của page là câu
  trả lời cho lượt toàn câu mẫu quảng cáo. Bản sửa bỏ ngoại lệ ấy; script này đo PHẠM VI thiệt hại trước / sau deploy.

  Thước đo, trên tin khách `status = SKIPPED · note = PAGE_REPLIED_REASON` trong cửa sổ:
   · ĐÓNG HỢP LỆ — lượt của tin ấy có câu trả lời hợp lệ (bot ERP · người đã xác minh · ứng dụng khác · chưa rõ người gửi mà không phải
     tin chào) theo ĐÚNG luật của `buildCustomerTurns`. Đây là «page đã trả lời» thật.
   · CHỐT NHẦM (falseAnswered) — lượt KHÔNG có câu trả lời hợp lệ nào: chỉ có tin tự động / chữ hệ thống / tin chào đầu phiên sau nó.
       - còn là lượt CUỐI (khách chưa nhắn gì thêm) ⇒ BỎ SÓT HIỆN TẠI (lostToSuppression): không ai trả lời khách tới giờ;
       - khách đã nhắn tiếp và lượt sau được trả lời ⇒ đã được đáp ở lượt sau (trễ, nhưng không mất);
       - khách đã nhắn tiếp mà lượt sau cũng chưa ai đáp ⇒ vẫn tính bỏ sót hiện tại.
   · Mỗi hội thoại bỏ sót hiện tại mang ba cờ: tuổi lượt ≤ 2 giờ (cơ chế «hết nhường thì đánh giá lại» — `resumeFanpageAfterPause`,
     RESUME_MAX_TURN_AGE_MS — sẽ tự trả lời MỘT lần sau deploy) · có người giữ (HANDOFF / có người phụ trách) · đã có đơn / đơn nháp.
     Lượt cũ hơn 2 giờ KHÔNG được AI tự nhắn bù (nhắn vào hội thoại đã nguội là làm phiền) — danh sách nằm ở phần MÃ HOÁ cho người.

  LUẬT DÙNG CHUNG, KHÔNG BẢN SAO: sổ dựng bằng `ledgerMessageOf` + `buildCustomerTurns` của image đang chạy, với cờ «câu mẫu» để TRỐNG.
  Với cờ trống, luật cũ và luật mới trùng nhau (ngoại lệ cũ chỉ bật khi MỌI tin của lượt là câu mẫu) ⇒ con số là của luật MỚI dù image
  chưa deploy bản sửa. Không gọi hàm lib nào đọc `getDb()`.

  arg: `<mã tổ chức> [--hours=1..336]` (mặc định 168 = 7 ngày; luôn in thêm cửa sổ 24 giờ). Kênh [ops:tom-tat] chỉ số đếm + tỷ lệ —
  KHÔNG tên, SĐT, chữ tin, mã hội thoại. Mã hội thoại bỏ sót chỉ ở phần MÃ HOÁ. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`, kiểm lại
  `default_transaction_read_only`); CSDL tổ chức mở bằng getDbForInspection (không migrate, không tạo).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("page-auto-skip-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import { buildCustomerTurns, type CustomerTurn, type LedgerMessage } from "@/lib/sales-chatbot/response-ownership";
import { ledgerMessageOf } from "@/lib/sales-chatbot/response-ownership-ledger";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Bản sao chữ của `fanpage.ts::PAGE_REPLIED_REASON` (bài kiểm so bằng nhau — script không nhập tệp máy chủ nặng). */
export const PAGE_REPLIED_NOTE = "Page đã trả lời (tự động của Meta / nhân viên) — bot không chen";
/** = RESUME_MAX_TURN_AGE_MS của response-ownership.ts (bài kiểm đối chiếu): lượt trẻ hơn mốc này được cơ chế sẵn có trả lời bù MỘT lần. */
export const TU_CUU_MS = 2 * 3_600_000;
export const MAC_DINH_GIO = 168;

export function docThamSo(argv: string[]): { org: string; hours: number } | { error: string } {
  const org = argv.find((a) => !a.startsWith("--"));
  if (!org || argv.filter((a) => !a.startsWith("--")).length !== 1) return { error: "cần ĐÚNG một mã tổ chức" };
  let hours = MAC_DINH_GIO;
  for (const a of argv.filter((x) => x.startsWith("--"))) {
    const m = /^--hours=(\d{1,3})$/.exec(a);
    if (!m) return { error: `cờ không nhận (${a.length} ký tự) — chỉ có --hours=1..336` };
    hours = Number(m[1]);
    if (hours < 1 || hours > 336) return { error: "--hours phải trong 1..336" };
  }
  return { org, hours };
}

export type PhanLoai = "DONG_HOP_LE" | "CHOT_NHAM_DA_DAP_SAU" | "CHOT_NHAM_BO_SOT";

/**
 * Phân loại MỘT tin khách bị chốt «page đã trả lời», theo các lượt của hội thoại (luật mới). `null` = tin không thuộc lượt nào (bị lọc
 * khỏi sổ — ảnh trống / nhập lịch sử). HÀM THUẦN.
 */
export function phanLoai(messageId: string, turns: readonly CustomerTurn[]): PhanLoai | null {
  const i = turns.findIndex((t) => t.messageIds.includes(messageId));
  if (i < 0) return null;
  if (turns[i].answered) return "DONG_HOP_LE";
  // Lượt không ai đáp. Còn lượt sau (khách nhắn tiếp) và lượt CUỐI đã được đáp ⇒ khách đã được trả lời ở lượt sau.
  const last = turns[turns.length - 1];
  return i < turns.length - 1 && last.answered ? "CHOT_NHAM_DA_DAP_SAU" : "CHOT_NHAM_BO_SOT";
}

export const tyLe = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1).replace(".", ",")}%` : "—");

// ─────────────────────────── PHẦN CHẠY ───────────────────────────

type DongSo = { id: string; messageId: string; text: string; note: string | null; status: string; createdAt: Date; sourceAt: Date | null; senderKind: string | null; importedAt: Date | null; imageUrls: unknown; threadId: string; pageId: string };

async function main(): Promise<number> {
  const ts = docThamSo(process.argv.slice(2));
  if ("error" in ts) {
    console.error(`Tham số: ${ts.error}. Dùng: <mã tổ chức> [--hours=1..336]`);
    return 2;
  }
  const org = await findOrganization(ts.org);
  if (!org) {
    console.error("Không tìm thấy tổ chức.");
    return 2;
  }
  const db: Db = await getDbForInspection(org);
  const ro = (rowsOf(await db.execute(sql`select current_setting('default_transaction_read_only') as v`))[0] as { v?: unknown } | undefined)?.v;
  if (ro !== "on") {
    console.error("Phiên KHÔNG chỉ đọc — dừng (script này không bao giờ ghi).");
    return 1;
  }
  const t = schema.salesChatInbound;
  const nowMs = Date.now();
  const since = new Date(nowMs - ts.hours * 3_600_000);
  const skipped = await db
    .select({ messageId: t.messageId, pageId: t.pageId, threadId: t.threadId, createdAt: t.createdAt })
    .from(t)
    .where(and(eq(t.status, "SKIPPED"), eq(t.note, PAGE_REPLIED_NOTE), gte(t.createdAt, since)));
  const theoLuong = new Map<string, typeof skipped>();
  for (const r of skipped) {
    const k = `${r.pageId}\u0000${r.threadId}`;
    theoLuong.set(k, [...(theoLuong.get(k) ?? []), r]);
  }

  const c = schema.salesChatConversations;
  const sm = schema.salesChatStaffMessages;
  const dem = { tong: 0, hopLe: 0, daDapSau: 0, boSot: 0, tong24: 0, boSot24: 0, khongXep: 0 };
  const hoiThoaiBoSot: { conv: string; tuoiPhut: number; tuCuu: boolean; nguoiGiu: boolean; coDon: boolean }[] = [];
  for (const [k, ds] of theoLuong) {
    const [pageId, threadId] = k.split("\u0000");
    const rows = (await db
      .select({ id: t.id, messageId: t.messageId, text: t.text, note: t.note, status: t.status, createdAt: t.createdAt, sourceAt: t.sourceAt, senderKind: t.senderKind, importedAt: t.importedAt, imageUrls: t.imageUrls, threadId: t.threadId, pageId: t.pageId })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), gte(t.createdAt, new Date(since.getTime() - 24 * 3_600_000))))
      .orderBy(desc(t.createdAt))
      .limit(400)) as DongSo[];
    const staffIds = rows.map((r) => (r.messageId.startsWith("staff-out:") ? r.messageId.slice(10).split(":")[0] : null)).filter((x): x is string => Boolean(x));
    const trangThaiNv = new Map<string, string>();
    if (staffIds.length) for (const s of await db.select({ id: sm.id, status: sm.status }).from(sm).where(inArray(sm.id, staffIds))) trangThaiNv.set(s.id, s.status);
    const flags = { customerTemplates: new Set<string>(), pageTemplateIds: new Set<string>() };
    const ledger = rows
      .map((r) => ledgerMessageOf({ ...r, staffStatus: r.messageId.startsWith("staff-out:") ? (trangThaiNv.get(r.messageId.slice(10).split(":")[0]) ?? null) : undefined } as Parameters<typeof ledgerMessageOf>[0], flags))
      .filter((m): m is LedgerMessage => m !== null);
    const turns = buildCustomerTurns(ledger);
    let boSotLuong = false;
    let tuoi = Infinity;
    for (const r of ds) {
      dem.tong += 1;
      const trong24 = nowMs - r.createdAt.getTime() <= 24 * 3_600_000;
      if (trong24) dem.tong24 += 1;
      const p = phanLoai(r.messageId, turns);
      if (p === null) dem.khongXep += 1;
      else if (p === "DONG_HOP_LE") dem.hopLe += 1;
      else if (p === "CHOT_NHAM_DA_DAP_SAU") dem.daDapSau += 1;
      else {
        dem.boSot += 1;
        if (trong24) dem.boSot24 += 1;
        boSotLuong = true;
        tuoi = Math.min(tuoi, nowMs - r.createdAt.getTime());
      }
    }
    if (boSotLuong) {
      const [cv] = await db.select({ id: c.id, status: c.status, assignee: c.assigneeUserId, orderId: c.orderId, draft: c.draftOrderId }).from(c).where(and(eq(c.pageId, pageId), eq(c.threadId, threadId))).limit(1);
      hoiThoaiBoSot.push({ conv: cv?.id ?? "(chưa có hội thoại)", tuoiPhut: Math.round(tuoi / 60_000), tuCuu: tuoi <= TU_CUU_MS, nguoiGiu: cv ? cv.status === "HANDOFF" || Boolean(cv.assignee) : false, coDon: cv ? Boolean(cv.orderId || cv.draft) : false });
    }
  }
  const tuCuu = hoiThoaiBoSot.filter((h) => h.tuCuu && !h.nguoiGiu && !h.coDon).length;
  tomTat(`page-auto-skip-audit ${ts.org} ${ts.hours} giờ: tin khách chốt «Page đã trả lời» ${dem.tong} · ĐÓNG HỢP LỆ ${dem.hopLe} · CHỐT NHẦM ${dem.daDapSau + dem.boSot} (${tyLe(dem.daDapSau + dem.boSot, dem.tong)})`);
  tomTat(`chốt nhầm: đã được đáp ở lượt sau ${dem.daDapSau} · BỎ SÓT HIỆN TẠI ${dem.boSot} tin / ${hoiThoaiBoSot.length} hội thoại · không xếp được ${dem.khongXep}`);
  tomTat(`24 giờ: chốt ${dem.tong24} · bỏ sót ${dem.boSot24} (${tyLe(dem.boSot24, dem.tong24)})`);
  tomTat(`hội thoại bỏ sót: ≤ 2 giờ, không người giữ, chưa đơn (cơ chế sẵn có tự trả lời MỘT lần sau deploy) ${tuCuu} · có người giữ ${hoiThoaiBoSot.filter((h) => h.nguoiGiu).length} · đã có đơn/nháp ${hoiThoaiBoSot.filter((h) => h.coDon).length} · cũ hơn 2 giờ (cho NGƯỜI, AI không nhắn bù) ${hoiThoaiBoSot.filter((h) => !h.tuCuu).length}`);
  console.log("── Hội thoại bỏ sót (MÃ HOÁ) — mở trong hộp thư: /ai/sales-chatbot/inbox?c=<mã> ──");
  for (const h of hoiThoaiBoSot.sort((a, b) => a.tuoiPhut - b.tuoiPhut)) console.log(`${h.conv} · ${h.tuoiPhut} phút · ${h.tuCuu ? "tự cứu" : "cho người"}${h.nguoiGiu ? " · có người giữ" : ""}${h.coDon ? " · có đơn" : ""}`);
  return 0;
}

if (CHAY_THANG) {
  main().then(
    (rc) => process.exit(rc),
    (e) => {
      console.error(`Lỗi: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      process.exit(1);
    },
  );
}
