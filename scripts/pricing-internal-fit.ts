/*
  `scripts/pricing-internal-fit.ts` (chạy tay: `npx tsx scripts/pricing-internal-fit.ts …`; CHƯA nối vào ops-vps.yml) — KHÁCH NỘI BỘ VÀO GÓI THƯỜNG NHỎ NHẤT VỪA SỐ DÙNG THẬT (docs/saas/PRICING_V1.md §9).

  MẶC ĐỊNH CHẠY THỬ: đo số dùng THẬT của kỳ đã qua (khách AI đo trọn kỳ · fanpage · người dùng) của workspace nhà (hoặc
  `--org=<mã>`), chọn gói rẻ nhất có số gồm phủ số dùng (`smallestFittingPlan`), in bảng kê chargeback ước tính bằng CÙNG
  phép tính phần vượt của khách ngoài. Không ghi gì.

  `--apply --reason="…"`: ghi gói đó vào cột gói của workspace (`platform_organizations.plan`) + ghim phiên bản giá hiện hành
  (nhật ký nền tảng `ORG_PLAN_SET`). Trần AI kỹ thuật của gói đích thấp hơn số dùng AI thật ⇒ KHÔNG gán.
  Thiếu một số đo (vd khách AI của nhà khi bot nhà còn chạy runtime cũ `chatbot/`) ⇒ KHÔNG gán — không gán gói bằng phỏng đoán.

  Chỉ in số đếm / tiền / mã tổ chức — không tên khách, không nội dung hội thoại. Dòng `[ops:tom-tat]` ra log công khai.

  arg: `--org=<mã>` · `--period=YYYY-MM-01` · `--apply` · `--reason=<lý do>`
*/
import "dotenv/config";
import { planInternalFit } from "@/lib/pricing/internal-fit";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const vnd = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("vi-VN")} ₫`);

async function main() {
  const apply = process.argv.includes("--apply");
  const r = await planInternalFit({ orgCode: arg("org") ?? undefined, periodMonth: arg("period") ?? undefined, apply, reason: arg("reason") ?? undefined, email: "script:pricing-internal-fit", source: "SCRIPT" });
  tomTat(`${apply ? "GÁN" : "CHẠY THỬ"} · tổ chức ${r.orgCode} (gói hiện tại ${r.currentPlanKey ?? "—"}) · kỳ ${r.periodMonth} · bảng giá ${r.versionKey ?? "—"}`);
  tomTat(`Số dùng: khách AI ${r.usage.aiCustomers ?? "—"} (${r.usage.aiCustomersCoverage}${r.usage.aiCustomersNote ? ` — ${r.usage.aiCustomersNote}` : ""}) · fanpage ${r.usage.fanpages ?? "—"} · người dùng ${r.usage.users ?? "—"} · cần AI bán hàng: ${r.usage.needsAiSales ? "có" : "không"}`);
  for (const c of r.fit.candidates) tomTat(`  ${c.fits ? "✓" : "✗"} ${c.name} ${vnd(c.monthlyVnd)}${c.why.length ? ` — ${c.why.join("; ")}` : ""}`);
  tomTat(`Kết luận: ${r.fit.plan ? `«${r.fit.plan.name}»` : "chưa chọn được gói"} — ${r.fit.reason}`);
  if (r.aiLimits) tomTat(`Trần AI kỹ thuật của gói đích: ${r.aiLimits.wouldExceed ? "SẼ CHẶN AI" : "không chặn"} (dùng ${r.aiLimits.requests} lượt · ${r.aiLimits.costUsd.toFixed(2)} USD kỳ đo)`);
  if (r.chargeback) tomTat(`Bảng kê chargeback ước tính: gói ${vnd(r.chargeback.planVnd)} + vượt ${vnd(r.chargeback.overage?.totalVnd ?? null)} = ${vnd(r.chargeback.totalVnd)}`);
  tomTat(r.message);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
