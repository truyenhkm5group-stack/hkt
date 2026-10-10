/*
  ops `order-cancel-reconcile` — ĐƠN KHÁCH ĐÃ HUỶ MÀ VẪN SỐNG (chủ shop 10/10/2026 — sự cố HSLC: AI «đồng ý huỷ», khung đơn vẫn
  «ĐÃ XÁC NHẬN»). Lõi: `lib/records/order-cancel-reconcile.ts` — CÙNG luật vòng đời vận đơn với bot (`customerCancelPlan`).

  MẶC ĐỊNH CHẠY THỬ: chỉ đọc, không gọi hãng vận chuyển, không ghi gì — in SỐ ĐẾM theo dấu vết (RESCUE_FAILED · AI_AGREED ·
  EXCEPTION_OPEN · CUSTOMER_FLAG · RESCUE_PENDING) × phân loại (huỷ được ngay · cần ĐVVC · cần người) + lý do cần người theo mã.
  `--apply` CHỈ chạm RESCUE_FAILED + AI_AGREED (quyết định cuối của khách đã rõ) qua ĐÚNG đường của bot: huỷ ngay / gọi hãng huỷ
  (chỉ coi là huỷ khi hãng xác nhận) / đẩy vào hàng ngoại lệ + cảnh báo người. Tác nhân là JOB (`userId = null`). Ghi hàng loạt trên
  production cần chủ shop duyệt (AGENTS §7) — người vận hành chạy thử trước, đọc số, rồi mới quyết.

  Không in mã đơn, tên, SĐT hay chữ khách. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] là số đếm.

  arg: `<mã tổ chức | --all> [--days=1..365] [--apply]`
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("order-cancel-reconcile.ts"));

import "dotenv/config";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { RECONCILE_DEFAULT_DAYS, RECONCILE_MAX_DAYS, reconcileOrderCancels, reconcileSummaryLines } from "@/lib/records/order-cancel-reconcile";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export type ReconcileArgs = { code: string | null; all: boolean; apply: boolean; days: number };

/** Đọc tham số. Cờ lạ / số sai ⇒ lỗi (không đoán). HÀM THUẦN. */
export function parseReconcileArgs(argv: readonly string[]): { ok: true; args: ReconcileArgs } | { ok: false; error: string } {
  let code: string | null = null;
  let all = false;
  let apply = false;
  let days = RECONCILE_DEFAULT_DAYS;
  for (const a of argv) {
    if (!a.startsWith("--")) {
      if (code !== null || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(a)) return { ok: false, error: "thiếu / sai mã tổ chức" };
      code = a;
      continue;
    }
    const [k, v = ""] = a.split("=", 2);
    if (k === "--apply" && !v) apply = true;
    else if (k === "--all" && !v) all = true;
    else if (k === "--days" && /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= RECONCILE_MAX_DAYS) days = Number(v);
    else return { ok: false, error: `cờ lạ / giá trị sai: ${a}` };
  }
  if (!all && !code) return { ok: false, error: "cần <mã tổ chức> hoặc --all" };
  if (all && code) return { ok: false, error: "chọn MỘT: <mã tổ chức> hoặc --all" };
  return { ok: true, args: { code, all, apply, days } };
}

async function main() {
  const parsed = parseReconcileArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`order-cancel-reconcile: ${parsed.error}. Dùng: <mã tổ chức | --all> [--days=1..${RECONCILE_MAX_DAYS}] [--apply]`);
    process.exit(2);
  }
  const { args } = parsed;
  const orgs = args.all ? (await listOrganizations()).filter((o) => o.status === "ACTIVE").map((o) => o.code) : [args.code!];
  if (!args.all && !(await findOrganization(args.code!))) {
    console.error("order-cancel-reconcile: không có tổ chức này");
    process.exit(2);
  }
  let total = 0;
  for (const code of orgs) {
    const report = await withOrganization(code, () => reconcileOrderCancels({ apply: args.apply, days: args.days }));
    total += report.candidates;
    for (const line of reconcileSummaryLines(code, report)) tomTat(line);
  }
  tomTat(`tổng ứng viên ${total} trên ${orgs.length} tổ chức · ${args.apply ? "ĐÃ ÁP DỤNG" : "CHẠY THỬ — chưa ghi gì"}`);
  process.exit(0);
}

if (CHAY_THANG) {
  main().catch((error) => {
    console.error("order-cancel-reconcile hỏng:", error instanceof Error ? error.message.slice(0, 300) : error);
    process.exit(1);
  });
}
