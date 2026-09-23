/**
 * ═══════════ NHÂN SỰ AI ĐÃ SẴN SÀNG VÀO VIỆC CHƯA — ĐO, KHÔNG KHẲNG ĐỊNH ═══════════
 *
 * Chủ shop hỏi 23/09/2026: "Sales AI agent đã sẵn sàng bắt đầu on job reply khách và học, sửa,
 * tối ưu liên tục case by case chưa?"
 *
 * Câu trả lời ấy KHÔNG được suy từ việc bài kiểm xanh hay deploy thành công. Giữa "khách nhắn một
 * câu" và "bản nháp nằm trong hàng đợi để chủ shop bấm" có mười ba cửa, mỗi cửa đóng được một
 * cách riêng, và mười hai cửa mở mà một cửa đóng thì kết quả vẫn là im lặng. Tiền lệ trong chính
 * kho mã này: dây chuyền chạy 1.065 lượt, mọi bảng đều xanh, và số tin thật sự tới khách là 0.
 *
 * Nên script này đi từng cửa, mỗi cửa một phép đo trên dữ liệu thật, và cửa nào đóng thì in ra
 * ĐÚNG câu lệnh mở nó. Không có ô nào ghi "OK" chung.
 *
 * ─── HAI ĐIỀU SCRIPT NÀY KHÔNG LÀM ───
 *
 * KHÔNG GHI GÌ. Không tạo việc, không gọi mô hình, không gửi tin, không đổi một dòng cấu hình.
 * Một lượt kiểm tra sẵn sàng mà tự sửa dữ liệu thì lần chạy thứ hai đo một hệ thống khác lần đầu.
 *
 * KHÔNG DỰNG LUẬT THỨ HAI. Mọi phép quyết định gọi lại đúng hàm mà dây chuyền gọi
 * (`shouldEngage`, `parseHandoverMode`, `clampMode`…). Chép điều kiện ra đây là mở đường cho một
 * ngày script nói "sẵn sàng" còn dây chuyền thì không — và người đọc sẽ tin script, vì nó dễ đọc
 * hơn.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { defaultProviderName } from "@/lib/ai-workforce/providers";
import { getAgent } from "@/lib/ai-workforce/registry";
import { modelSpendLast24h } from "@/lib/ai-workforce/events";
import { clampMode, modeAtLeast } from "@/lib/constants/ai";
import {
  CUSTOMER_TURNS_BEFORE_AI,
  DEFAULT_HANDOVER_MODE,
  HANDOVER_MODE_KEY,
  HANDOVER_MODE_LABEL,
  parseHandoverMode,
} from "@/lib/constants/sales-handover";
import { COPILOT_PAGES_KEY } from "@/lib/constants/sales-copilot";
import { BOT_SENDER_NAMES_KEY } from "@/lib/constants/sales-ingest";
import { getSettingValue } from "@/lib/settings";
import { learningSummary } from "@/lib/queries/copilot-learning";

/**
 * `CHUA_BIET` tách hẳn khỏi `CHUA`, và đó không phải chuyện chữ nghĩa: "cửa này đóng" dẫn người
 * đọc đi mở nó, còn "chưa đo được cửa này" dẫn họ đi lấy dữ liệu. Gộp hai thứ lại là bắt người
 * đọc đi sửa nhầm chỗ (luật 45).
 */
type Verdict = "SAN_SANG" | "CHUA" | "CHUA_BIET";

const DAU: Record<Verdict, string> = { SAN_SANG: "✓", CHUA: "✗", CHUA_BIET: "?" };

type Cua = { ten: string; verdict: Verdict; thay: string; lamGi?: string };

const cua: Cua[] = [];
function ghi(ten: string, verdict: Verdict, thay: string, lamGi?: string) {
  cua.push({ ten, verdict, thay, lamGi });
}

async function main() {
  const db = await getDb();
  const settings = await getAiSettings();

  console.log("═══════════ NHÂN SỰ AI BÁN HÀNG ĐÃ SẴN SÀNG VÀO VIỆC CHƯA ═══════════");
  console.log(`đo lúc: ${new Date().toISOString()}`);
  console.log("");

  // ───── 1. NHÂN SỰ CÓ ĐANG BẬT, VÀ Ở NẤC NÀO ─────
  const agent = await getAgent("sales", settings, db);
  if (!agent) {
    ghi("1. Nhân sự bán hàng trong sổ đăng ký", "CHUA", "không tìm thấy", "ops ai-staging-up để dựng lại bản chạy thử");
  } else {
    const nacThat = clampMode(agent.mode);
    const guiDuoc = modeAtLeast(nacThat, "COPILOT");
    ghi(
      "1. Nấc quyền hạn",
      agent.mode === "OFF" || !guiDuoc ? "CHUA" : "SAN_SANG",
      `khai ${agent.mode} · có hiệu lực ${nacThat}${agent.mode !== nacThat ? " (bị kẹp xuống)" : ""}`,
      guiDuoc ? undefined : "ops ai-staging-copilot, arg: --page=<id> --on",
    );
  }

  // ───── 2. GỌI MÔ HÌNH ─────
  ghi(
    "2. Gọi mô hình",
    settings.modelCallsEnabled ? "SAN_SANG" : "CHUA",
    settings.modelCallsEnabled ? `bật · nhà cung cấp ${defaultProviderName()}` : "TẮT — dây chuyền chỉ dùng mẫu câu cứng",
    settings.modelCallsEnabled ? undefined : "ops ai-staging-setting, arg: ai.config với modelCallsEnabled=true",
  );

  /*
    ───── 3. TRẦN CHI PHÍ — CỬA NÀY ĐÓNG IM LẶNG ─────

    Trần > 0 mà có lượt gọi chưa định giá thì dây chuyền DỪNG ở MỌI việc. Nó là cửa dễ đóng nhất
    mà khó nhìn ra nhất: màn hình báo "chưa tiêu gì" trong khi không việc nào chạy được.
  */
  if (settings.dailyCostCapVnd > 0) {
    const chi = await modelSpendLast24h(db);
    if (chi.unpricedCalls > 0) {
      ghi(
        "3. Trần chi phí ngày",
        "CHUA",
        `trần ${settings.dailyCostCapVnd} ₫ nhưng ${chi.unpricedCalls} lượt gọi trong 24 giờ CHƯA ĐỊNH GIÁ ⇒ dây chuyền dừng mọi việc`,
        "khai đơn giá ở settings ai.pricing cho đúng mã mô hình đang chạy",
      );
    } else if (chi.vnd >= settings.dailyCostCapVnd) {
      ghi("3. Trần chi phí ngày", "CHUA", `đã tiêu ${chi.vnd} ₫ / trần ${settings.dailyCostCapVnd} ₫ — đã chạm`, "nâng ai.config.dailyCostCapVnd");
    } else {
      ghi("3. Trần chi phí ngày", "SAN_SANG", `đã tiêu ${chi.vnd} ₫ / trần ${settings.dailyCostCapVnd} ₫ · 0 lượt chưa định giá`);
    }
  } else {
    ghi("3. Trần chi phí ngày", "SAN_SANG", "chưa khai trần (0 = không giới hạn, không phải cấm tiêu)");
  }

  // ───── 4. CÁCH BÀN GIAO ─────
  const mode = parseHandoverMode(await getSettingValue<unknown>(HANDOVER_MODE_KEY, DEFAULT_HANDOVER_MODE));
  ghi("4. Cách bàn giao", "SAN_SANG", `${HANDOVER_MODE_LABEL[mode]} ⇒ AI vào việc từ lượt khách thứ ${CUSTOMER_TURNS_BEFORE_AI[mode]}`);

  // ───── 5. PAGE ĐƯỢC PHÉP BẤM GỬI ─────
  const pagesRaw = await getSettingValue<string[]>(COPILOT_PAGES_KEY, []);
  const dsPage = Array.isArray(pagesRaw) ? pagesRaw.filter((p) => typeof p === "string" && p.trim()) : [];
  ghi(
    "5. Page thí điểm (nút Gửi)",
    dsPage.length ? "SAN_SANG" : "CHUA",
    dsPage.length ? dsPage.join(", ") : "DANH SÁCH RỖNG ⇒ mọi lượt bấm Gửi đều bị từ chối",
    dsPage.length ? undefined : "ops ai-staging-copilot, arg: --page=<id> --on",
  );

  /*
    ───── 6. BỘ NẠP CÓ ĐANG QUAY ─────

    Mốc đọc gần nhất là bằng chứng DUY NHẤT bộ nạp còn sống. Container "Up" chỉ nói tiến trình
    chưa chết, không nói vòng lặp còn quay — hai điều đó đã từng khác nhau.
  */
  const napRows = await db
    .execute(
      sql`select page_id::text as page, max(last_poll_at)::text as vong, max(consecutive_failures) as hong, max(last_error) as loi
          from ai_live_ingest_state group by page_id`,
    )
    .catch(() => null);
  const rows = (napRows?.rows ?? []) as Record<string, unknown>[];
  if (!rows.length) {
    ghi("6. Bộ nạp tin sống", "CHUA_BIET", "chưa có mốc đọc nào trong CSDL", "ops ai-staging-live-ingest, arg: --on --seconds=45");
  } else {
    for (const r of rows) {
      const vong = r.vong ? new Date(String(r.vong)) : null;
      const phut = vong && !Number.isNaN(vong.getTime()) ? Math.round((Date.now() - vong.getTime()) / 60_000) : null;
      ghi(
        `6. Bộ nạp · page ${r.page}`,
        phut === null ? "CHUA_BIET" : phut <= 5 ? "SAN_SANG" : "CHUA",
        phut === null
          ? "chưa quay vòng nào"
          : `vòng gần nhất ${phut} phút trước · hỏng liên tiếp ${r.hong ?? 0}${r.loi ? ` · ${String(r.loi).slice(0, 80)}` : ""}`,
        phut !== null && phut <= 5 ? undefined : "ops ai-staging-live-ingest, arg: --on --seconds=45",
      );
    }
  }

  /*
    ───── 7. TIN PHÍA SHOP CÓ CÒN BỊ NHẬN NHẦM LÀ NGƯỜI ─────

    Một tin của máy bị xếp là NGƯỜI sẽ bật cờ "người đang cầm", và nhân sự AI đứng im ở đúng cuộc
    đó — im lặng, không báo lỗi. Đây chính là cách cửa này đã đóng suốt đợt chạy thử trước.
  */
  const [pl] = await db
    .select({
      human: sql<number>`count(*) filter (where ${schema.salesMessages.senderType} = 'PAGE_HUMAN')`,
      bot: sql<number>`count(*) filter (where ${schema.salesMessages.senderType} = 'PAGE_BOT')`,
      sys: sql<number>`count(*) filter (where ${schema.salesMessages.senderType} = 'PAGE_SYSTEM')`,
    })
    .from(schema.salesMessages)
    .where(eq(schema.salesMessages.fromPage, true));
  const tenMayRaw = await getSettingValue<string[]>(BOT_SENDER_NAMES_KEY, []);
  const tenMay = Array.isArray(tenMayRaw) ? tenMayRaw : [];
  ghi(
    "7. Phân loại người gửi",
    Number(pl?.human ?? 0) === 0 ? "SAN_SANG" : "CHUA",
    `người ${pl?.human ?? 0} · máy ${pl?.bot ?? 0} · nền tảng ${pl?.sys ?? 0} · tên máy đã khai: ${tenMay.length ? tenMay.join(", ") : "(chưa khai)"}`,
    Number(pl?.human ?? 0) === 0 ? undefined : "ops ai-staging-reclassify, arg: --apply",
  );

  // ───── 8. HỘI THOẠI ĐANG BỊ CHẶN VÌ NGƯỜI ĐANG CẦM ─────
  const [cam] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.salesConversations)
    .where(sql`${schema.salesConversations.humanTakeoverAt} is not null`);
  ghi("8. Hội thoại người đang cầm", "SAN_SANG", `${cam?.n ?? 0} cuộc — AI im ở những cuộc này (đúng luật). Cuộc MỚI không bị ảnh hưởng.`);

  // ───── 9. BẢNG SỐ ĐO ─────
  const bang = await getSettingValue<unknown>("ai.sizeRules", null);
  const soBang = bang && typeof bang === "object" ? Object.keys(bang as Record<string, unknown>).length : 0;
  ghi(
    "9. Bảng số đo",
    soBang > 0 ? "SAN_SANG" : "CHUA",
    soBang > 0 ? `${soBang} khoá đã khai` : "chưa khai ⇒ mọi câu hỏi size đều chuyển người",
    soBang > 0 ? undefined : "khai ở /ai/size-rules, hoặc ops ai-staging-size-rules --apply",
  );

  // ───── 10. DANH MỤC SẢN PHẨM ─────
  const [sp] = await db.select({ n: sql<number>`count(*)` }).from(schema.products);
  ghi("10. Danh mục sản phẩm", Number(sp?.n ?? 0) > 0 ? "SAN_SANG" : "CHUA", `${sp?.n ?? 0} mẫu mã`, Number(sp?.n ?? 0) > 0 ? undefined : "ops sync-pancake-all");

  // ───── 11. VIỆC ĐANG XẾP HÀNG ─────
  const [viec] = await db
    .select({
      cho: sql<number>`count(*) filter (where ${schema.aiTasks.status} = 'PENDING')`,
      hong: sql<number>`count(*) filter (where ${schema.aiTasks.status} = 'FAILED')`,
    })
    .from(schema.aiTasks)
    .where(gte(schema.aiTasks.createdAt, new Date(Date.now() - 86_400_000)));
  ghi("11. Việc 24 giờ qua", "SAN_SANG", `đang chờ ${viec?.cho ?? 0} · hỏng ${viec?.hong ?? 0}`);

  // ───── 12. HÀNG ĐỢI NHÁP ─────
  const [nhap] = await db
    .select({
      chua: sql<number>`count(*) filter (where ${schema.salesSuggestions.sent} = false)`,
      daGui: sql<number>`count(*) filter (where ${schema.salesSuggestions.sent} = true)`,
    })
    .from(schema.salesSuggestions);
  ghi("12. Hàng đợi bản nháp", "SAN_SANG", `chờ duyệt ${nhap?.chua ?? 0} · đã gửi ${nhap?.daGui ?? 0}`);

  // ───── 13. VÒNG HỌC ─────
  const hoc = await learningSummary(dsPage, 30, db);
  ghi(
    "13. Vòng học từ chỗ shop sửa",
    "SAN_SANG",
    hoc.total === 0
      ? "0 lượt gửi — vòng học đã nối nhưng CHƯA CÓ GÌ ĐỂ HỌC (đúng, chưa ai bấm gửi lần nào)"
      : `${hoc.total} lượt · nguyên văn ${hoc.byKind.SENT_AS_IS} · sửa giọng ${hoc.byKind.WORDING} · sửa dữ kiện ${hoc.byKind.FACTS} · viết lại ${hoc.byKind.REWRITE}`,
  );

  const [tin] = await db
    .select({ moi: sql<string>`max(${schema.salesMessages.sentAt})::text` })
    .from(schema.salesMessages)
    .where(and(eq(schema.salesMessages.fromPage, false), eq(schema.salesMessages.senderType, "CUSTOMER")));

  console.log("──────────────── TỪNG CỬA ────────────────");
  for (const c of cua) {
    console.log(`  ${DAU[c.verdict]} ${c.ten}: ${c.thay}`);
    if (c.lamGi) console.log(`      → ${c.lamGi}`);
  }

  const dong = cua.filter((c) => c.verdict === "CHUA");
  const chuaDo = cua.filter((c) => c.verdict === "CHUA_BIET");

  console.log("");
  console.log("──────────────── PHÁN QUYẾT ────────────────");
  if (!dong.length && !chuaDo.length) {
    console.log("  ✓ MỌI CỬA ĐỀU MỞ. Khách nhắn là có bản nháp trong hàng đợi.");
  } else {
    if (dong.length) console.log(`  ✗ ${dong.length} cửa ĐANG ĐÓNG: ${dong.map((c) => c.ten).join(" · ")}`);
    if (chuaDo.length) console.log(`  ? ${chuaDo.length} cửa CHƯA ĐO ĐƯỢC: ${chuaDo.map((c) => c.ten).join(" · ")}`);
  }

  /*
    MỌI CỬA MỞ VẪN KHÔNG CÓ NGHĨA LÀ SẼ CÓ BẢN NHÁP NGAY.

    Dây chuyền chỉ chạy khi KHÁCH NHẮN. Không nói ra điều này thì một màn hình toàn dấu ✓ đứng
    cạnh một hàng đợi rỗng đọc lên như một hệ thống hỏng, và người ta sẽ đi sửa thứ không hỏng.
  */
  console.log("");
  console.log("──────────────── CÓ VIỆC ĐỂ LÀM KHÔNG ────────────────");
  if (!tin?.moi) {
    console.log("  Chưa có tin nào của khách trong CSDL.");
  } else {
    const gio = Math.round((Date.now() - new Date(tin.moi).getTime()) / 3_600_000);
    console.log(`  Tin khách mới nhất: ${tin.moi} (${gio} giờ trước)`);
    if (gio > 6) {
      console.log("  ⇒ Hàng đợi rỗng lúc này KHÔNG phải lỗi: dây chuyền chỉ chạy khi khách nhắn.");
      console.log(`    Bản nháp đầu tiên xuất hiện ở lượt khách thứ ${CUSTOMER_TURNS_BEFORE_AI[mode]} của một cuộc mới.`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
