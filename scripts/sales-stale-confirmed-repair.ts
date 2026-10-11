/*
  ops `sales-stale-confirmed-repair` — HỘI THOẠI CÓ ĐƠN ĐÃ XÁC NHẬN MÀ SỔ CÒN NÓI «CHƯA CHỐT» (chủ shop ghi đè 11/10/2026 · P0-B / P0-H).

  Ca thật (HSLC — KimThu Le, Kiều Văn Lệ): khung đơn «ĐÃ XÁC NHẬN» mà bot vẫn nhắn «có muốn tiếp tục chốt đơn không?». Đường chạy
  nay dọn sổ ngay khi phát hiện (lúc xếp lịch · lúc job follow-up chạy) — script này dọn các dòng đã kẹt TỪ TRƯỚC. Lõi:
  `lib/sales-chatbot/confirmed-settle.ts::repairStaleConfirmed` — CÙNG phép dọn với đường chạy, «đã xác nhận» đọc từ `lifecycle.ts`.

  CẦN DEPLOY PR #801 TRƯỚC: ops lấy script từ `main` nhưng `lib/` từ image đang chạy — image cũ không có `confirmed-settle.ts`.

  MẶC ĐỊNH CHẠY THỬ: chỉ đọc, không ghi một dòng — in SỐ ĐẾM: (a) hội thoại có đơn đã xác nhận mà còn lịch follow-up · (b) còn
  `WAITING` / bước bán hàng ≠ DONE (tách bước CONFIRM) · không đọc được (không đụng). `--apply` mới ghi: huỷ lịch, `WAITING` ⇒ `OPEN`,
  bước `DONE`, một dòng vết `stage.changed` (SYSTEM · `CONFIRMED_ORDER` · via REPAIR). KHÔNG đụng đơn, KHÔNG gửi tin. Chạy lại =
  không ghi thêm gì (idempotent). Ghi hàng loạt trên production cần chủ shop duyệt (AGENTS §7) — chủ shop đã yêu cầu rõ 11/10/2026;
  người vận hành vẫn chạy thử trước, đọc số, rồi mới `--apply`.

  Không in mã hội thoại, tên, SĐT hay chữ khách. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] là số đếm.

  arg: `<mã tổ chức | --all> [--days=1..120] [--apply]`
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("sales-stale-confirmed-repair.ts"));

import "dotenv/config";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { repairStaleConfirmed, STALE_REPAIR_DEFAULT_DAYS, STALE_REPAIR_MAX_DAYS, staleRepairSummaryLines } from "@/lib/sales-chatbot/confirmed-settle";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export type StaleRepairArgs = { code: string | null; all: boolean; apply: boolean; days: number };

/** Đọc tham số. Cờ lạ / số sai ⇒ lỗi (không đoán). HÀM THUẦN. */
export function parseStaleRepairArgs(argv: readonly string[]): { ok: true; args: StaleRepairArgs } | { ok: false; error: string } {
  let code: string | null = null;
  let all = false;
  let apply = false;
  let days = STALE_REPAIR_DEFAULT_DAYS;
  for (const a of argv) {
    if (!a.startsWith("--")) {
      if (code !== null || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(a)) return { ok: false, error: "thiếu / sai mã tổ chức" };
      code = a;
      continue;
    }
    const [k, v = ""] = a.split("=", 2);
    if (k === "--apply" && !v) apply = true;
    else if (k === "--all" && !v) all = true;
    else if (k === "--days" && /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= STALE_REPAIR_MAX_DAYS) days = Number(v);
    else return { ok: false, error: `cờ lạ / giá trị sai: ${a}` };
  }
  if (!all && !code) return { ok: false, error: "cần <mã tổ chức> hoặc --all" };
  if (all && code) return { ok: false, error: "chọn MỘT: <mã tổ chức> hoặc --all" };
  return { ok: true, args: { code, all, apply, days } };
}

async function main() {
  const parsed = parseStaleRepairArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`sales-stale-confirmed-repair: ${parsed.error}. Dùng: <mã tổ chức | --all> [--days=1..${STALE_REPAIR_MAX_DAYS}] [--apply]`);
    process.exit(2);
  }
  const { args } = parsed;
  if (!args.all && !(await findOrganization(args.code!))) {
    console.error("sales-stale-confirmed-repair: không có tổ chức này");
    process.exit(2);
  }
  const orgs = args.all ? (await listOrganizations()).filter((o) => o.status === "ACTIVE").map((o) => o.code) : [args.code!];
  let stale = 0;
  let repaired = 0;
  let failed = 0;
  for (const code of orgs) {
    try {
      const report = await withOrganization(code, () => repairStaleConfirmed({ apply: args.apply, days: args.days }));
      stale += report.stale;
      repaired += report.repaired;
      for (const line of staleRepairSummaryLines(code, report)) tomTat(line);
    } catch (error) {
      // Một tổ chức hỏng (chưa bật module / CSDL lỗi) không chặn tổ chức khác — nhưng phải NÓI RA, không im.
      failed += 1;
      tomTat(`${code}: KHÔNG chạy được — ${error instanceof Error ? error.message.slice(0, 160) : "lỗi"}`);
    }
  }
  tomTat(`tổng cần dọn ${stale} · ${args.apply ? `đã dọn ${repaired}` : "CHẠY THỬ — chưa ghi gì"} · ${orgs.length} tổ chức${failed ? ` · ${failed} tổ chức lỗi` : ""}`);
  process.exit(failed ? 1 : 0);
}

if (CHAY_THANG) {
  main().catch((error) => {
    console.error("sales-stale-confirmed-repair hỏng:", error instanceof Error ? error.message.slice(0, 300) : error);
    process.exit(1);
  });
}
