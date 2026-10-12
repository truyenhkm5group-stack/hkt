/*
  ops `sales-postorder-handoff-release` — TRẢ CHO AI HỘI THOẠI KẸT VÌ LUẬT CŨ «KHÁCH NHẮN SAU KHI CHỐT ĐƠN ⇒ CHUYỂN NGƯỜI» (HOTFIX P0
  12/10/2026, ca HSLC «Khanh Nhung»).

  Lõi: `lib/sales-chatbot/postorder-release.ts::releaseLegacyPostOrderHandoffs`. CẦN DEPLOY bản vá engine TRƯỚC (ops lấy script từ
  `main` nhưng `lib/` từ image đang chạy): image cũ còn luật cũ ⇒ hội thoại vừa trả về sẽ bị chuyển người lại ở tin khách kế tiếp.

  MẶC ĐỊNH CHẠY THỬ: chỉ đọc — in SỐ ĐẾM theo phán quyết (trả được · có người phụ trách · nhân viên đã trả lời sau khi chuyển · đang
  tiếp quản). `--apply` mới ghi: hội thoại KHÔNG AI ĐANG CẦM ⇒ `OPEN`, xoá dấu hàng đợi, một dòng `ai.resumed` (SYSTEM · RETURNED ·
  via POSTORDER_RELEASE) + nhật ký. KHÔNG gửi tin, KHÔNG đụng đơn, KHÔNG đụng lý do chuyển người khác. Ghi hàng loạt trên production
  cần chủ shop duyệt (AGENTS §7): chạy thử, gửi số cho chủ shop, rồi mới `--apply`.

  Không in mã hội thoại, tên, SĐT hay chữ khách. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] là số đếm.

  arg: `<mã tổ chức | --all> [--apply]`
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("sales-postorder-handoff-release.ts"));

import "dotenv/config";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { releaseLegacyPostOrderHandoffs, releaseSummaryLines } from "@/lib/sales-chatbot/postorder-release";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export type ReleaseArgs = { code: string | null; all: boolean; apply: boolean };

/** Đọc tham số. Cờ lạ ⇒ lỗi (không đoán). HÀM THUẦN. */
export function parseReleaseArgs(argv: readonly string[]): { ok: true; args: ReleaseArgs } | { ok: false; error: string } {
  let code: string | null = null;
  let all = false;
  let apply = false;
  for (const a of argv.map((x) => x.trim()).filter(Boolean)) {
    if (a === "--apply") apply = true;
    else if (a === "--all") all = true;
    else if (!a.startsWith("--") && code === null && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(a)) code = a;
    else return { ok: false, error: `cờ lạ / giá trị sai: ${a}` };
  }
  if (!all && !code) return { ok: false, error: "cần <mã tổ chức> hoặc --all" };
  if (all && code) return { ok: false, error: "chọn MỘT: <mã tổ chức> hoặc --all" };
  return { ok: true, args: { code, all, apply } };
}

function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

async function main() {
  const parsed = parseReleaseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    tomTat(`sales-postorder-handoff-release: DỪNG · ${parsed.error} (arg: <mã tổ chức | --all> [--apply])`);
    return exitAfterFlush(2);
  }
  const { args } = parsed;
  if (!args.all && !(await findOrganization(args.code!))) {
    tomTat("sales-postorder-handoff-release: DỪNG · không có tổ chức này");
    return exitAfterFlush(2);
  }
  const orgs = args.all ? (await listOrganizations()).filter((o) => o.isHome || o.status === "ACTIVE").map((o) => o.code) : [args.code!];
  let candidates = 0;
  let released = 0;
  let failed = 0;
  for (const code of orgs) {
    try {
      const report = await withOrganization(code, () => releaseLegacyPostOrderHandoffs({ apply: args.apply }));
      candidates += report.candidates;
      released += report.released;
      for (const line of releaseSummaryLines(code, report)) tomTat(line);
    } catch (error) {
      failed += 1;
      tomTat(`${code}: KHÔNG chạy được — ${error instanceof Error ? error.message.slice(0, 160) : "lỗi"}`);
    }
  }
  tomTat(`tổng kẹt luật cũ ${candidates} · ${args.apply ? `đã trả cho AI ${released}` : "CHẠY THỬ — chưa ghi gì"} · ${orgs.length} tổ chức${failed ? ` · ${failed} tổ chức lỗi` : ""}`);
  exitAfterFlush(failed ? 1 : 0);
}

if (CHAY_THANG) {
  main().catch((error) => {
    console.error("sales-postorder-handoff-release hỏng:", error instanceof Error ? error.message.slice(0, 300) : error);
    exitAfterFlush(1);
  });
}
