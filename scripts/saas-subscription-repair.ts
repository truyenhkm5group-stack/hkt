/*
  `scripts/saas-subscription-repair.ts` (chạy tay: `npx tsx scripts/saas-subscription-repair.ts …`; CHƯA nối vào ops-vps.yml —
  chủ shop quyết có sửa bù workspace thật hay không) — SỬA BÙ THUÊ BAO CỦA CỬA HÀNG TỰ ĐĂNG KÝ (kiểm vỏ khách 08/10/2026 · F-02).

  MẶC ĐỊNH CHẠY THỬ (chỉ đọc): liệt kê workspace không phải nhà, có thương hiệu (tự đăng ký qua `/start`), đang thiếu thuê bao —
  sản phẩm sẽ mở (theo module, cùng luật `/start`), tình trạng sẽ hiện, mốc dùng thử đã chụp lúc đăng ký, hệ quả. Không ghi gì.

  `--apply --reason="…"`: mở thuê bao qua ĐÚNG hàm của `/start` (`lib/saas/signup-subscriptions.ts::openSignupSubscriptions`) —
  chỉ thêm, idempotent, nhật ký `PRODUCT_SUBSCRIBE` mang lý do. KHÔNG bật thu phí, KHÔNG đổi dùng thử, KHÔNG tạo khoá.

  Chỉ in mã workspace / mã tài khoản / khoá sản phẩm / ngày — không tên khách, không email. Dòng `[ops:tom-tat]` ra log công khai.

  arg: `--org=<mã>` · `--apply` · `--reason=<lý do>`
*/
import "dotenv/config";
import { planSubscriptionRepair, REPAIR_CONSEQUENCES } from "@/lib/saas/subscription-repair";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

async function main() {
  const apply = process.argv.includes("--apply");
  const r = await planSubscriptionRepair({ apply, reason: arg("reason"), orgCode: arg("org") });
  tomTat(`${apply ? "SỬA BÙ" : "CHẠY THỬ (không ghi)"} · ${r.at} · ${r.candidates.length} workspace thiếu thuê bao (${r.candidates.filter((c) => c.action === "OPEN").length} mở được)`);
  if (r.error) {
    tomTat(`DỪNG: ${r.error}`);
    process.exitCode = 1;
    return;
  }
  for (const c of r.candidates) {
    tomTat(`• ${c.orgCode} · ${c.orgStatus} · thương hiệu ${c.brand} (bán ${c.brandProduct ?? "—"}) · dựng qua ${c.onboardingSource ?? "—"} · tạo ${c.createdAt.slice(0, 10)} · tài khoản ${c.accountCode ?? "CHƯA GẮN"}`);
    tomTat(`    đang dùng theo module: ${c.inUse.join(", ") || "—"} · thuê bao sống: ${c.live.join(", ") || "không có"} · ${c.action === "OPEN" ? `MỞ: ${c.toOpen.join(", ")} ⇒ sẽ hiện «${c.statusAfterOpenLabel ?? "—"}»` : "BỎ QUA"}`);
    tomTat(`    thu phí: ${c.billing.terms} · ${c.billing.standing} · trả tới ${c.billing.paidThrough ?? "—"} · chỉ xem từ ${c.billing.lockOn ?? "—"} · dùng thử ${c.billing.trialDays ?? "—"} ngày (${c.billing.trialStartedAt?.slice(0, 10) ?? "—"} → ${c.billing.trialEndsAt?.slice(0, 10) ?? "—"})`);
    tomTat(`    ${c.billing.note}`);
    for (const n of c.notes) tomTat(`    ! ${n}`);
  }
  tomTat("Hệ quả của --apply:");
  for (const line of REPAIR_CONSEQUENCES) tomTat(`  - ${line}`);
  for (const x of r.results) tomTat(`KẾT QUẢ ${x.orgCode}: ${x.outcome.ok ? `mở ${x.outcome.opened.join(", ") || "(không có gì mới)"}` : `HỎNG — ${x.outcome.error}`} · thuê bao sống sau: ${x.liveAfter.join(", ") || "không có"}`);
  if (r.results.some((x) => !x.outcome.ok)) process.exitCode = 1;
  if (!apply && r.candidates.some((c) => c.action === "OPEN")) tomTat('Ghi thật: thêm --apply --reason="<lý do + ai duyệt>".');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
