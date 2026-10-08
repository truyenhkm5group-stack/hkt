/*
  ops `org-prepaid-ai` — ĐƯA MỘT TỔ CHỨC KHÁCH SANG «AI DÙNG CHUNG TRẢ TRƯỚC THEO KHÁCH AI» (docs/saas/AI_BALANCE_V1.md §7).

  Vì sao (08/10/2026, chủ shop): HSLC (`hslc-hmt-shop`) phải dùng AI dùng chung của nền tảng NHƯ MỘT KHÁCH — nạp tiền qua QR (Số
  dư AI), nạp bao nhiêu dùng bấy nhiêu, mọi khách AI trừ số dư, KHÔNG có credit nền tảng miễn phí. Chế độ là DỮ LIỆU (phiên bản giá
  «Trả trước theo khách AI» + cờ Số dư AI), không phải nhánh theo mã tổ chức — lõi ở `lib/billing/prepaid-ai.ts`.

  Ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thiếu / thừa ⇒ lỗi cách dùng (mã 64):
   · `<mã>`          CHẠY THỬ (CHỈ ĐỌC — Postgres ép, hỏi lại trước khi đọc): tổ chức · gói / phiên bản giá đang áp · tài khoản nhận
                     tiền đã khai chưa · cờ Số dư AI · số dư (đủ ≈ bao nhiêu giờ) · động cơ AI Bán hàng đang lưu · hoá đơn gia hạn
                     đang mở · đơn giá khách AI sẽ trừ · trần AI hiện tại / sau kích hoạt / sau cutover · mức dùng 7 ngày quy ra khách
                     AI × đơn giá ≈ tiền / ngày + gợi ý nạp 7 / 30 ngày · credit gợi ý · khách AI của kỳ chưa có dòng trừ · BƯỚC KẾ TIẾP.
   · `<mã> --apply [--unit=<đ>] [--force-low-balance]`
                     làm ĐÚNG MỘT bước kế tiếp (đọc lại tươi trước khi ghi), qua lõi có sẵn + nhật ký nền tảng nguồn SCRIPT:
                       1. MỞ NẠP     — bật cờ Số dư AI khi tổ chức còn ở giá cũ (chưa trừ, chưa chặn gì) để chủ shop nạp;
                       2. CHỜ NẠP    — số dư < max(100.000đ, ước tính 1 ngày) ⇒ TỪ CHỐI ghim (`--force-low-balance` hạ xuống > 0;
                                       số dư ≤ 0 thì KHÔNG BAO GIỜ ghim — bot im với khách thật);
                       3. KÍCH HOẠT  — đòi `--unit=<đ>` KHỚP đơn giá đọc lúc ghi; chặn khi còn hoá đơn gia hạn đang mở theo giá cũ;
                                       phát hành phiên bản (nếu chưa có) + ghim tổ chức.
                     KHÔNG đổi động cơ AI (việc của `org-ai-cutover <mã> --apply --credit=<USD>` NGAY SAU kích hoạt), KHÔNG đặt
                     credit, KHÔNG khai tài khoản nhận tiền — chưa khai ⇒ CHẶN mọi bước và nói chủ shop phải khai ở /platform.

  Cả lượt chạy trong `ma_hoa_ket_qua`: số dư, số tiền, mức dùng của khách CHỈ nằm ở phần MÃ HOÁ; dòng `[ops:tom-tat] ` (log công
  khai — kho PUBLIC) chỉ mang nhãn và phán quyết (bước · đã khai / chưa · bật / tắt · dương / chưa), không một con số tiền nào.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-prepaid-ai.ts"));
const CO_GHI = ARGS.includes("--apply");
if (CHAY_THANG && !CO_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { applyPrepaidAiStep, planPrepaidAi, platformDbReadOnly, PREPAID_STEP_LABEL, type PrepaidPlan } from "@/lib/billing/prepaid-ai";
import type { AiLimits } from "@/lib/ai-usage/types";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

export const SCRIPT_LABEL = "script:org-prepaid-ai";

export type PrepaidArgs = { ok: true; code: string; apply: boolean; unitVnd: number | null; forceLowBalance: boolean } | { ok: false; error: string };

/** Ô arg ⇒ chế độ. Cờ lạ / lặp / sai cặp ⇒ lỗi cách dùng — không đoán ý (gõ nhầm `--aply` mà vẫn chạy là ghi mù). Không lặp lại giá trị đã gõ. */
export function parsePrepaidArgs(args: readonly string[]): PrepaidArgs {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (positional.length !== 1) return { ok: false, error: positional.length ? "chỉ nhận MỘT mã tổ chức" : "thiếu mã tổ chức" };
  const known = (f: string) => f === "--apply" || f === "--force-low-balance" || f.startsWith("--unit=");
  if (flags.some((f) => !known(f))) return { ok: false, error: "cờ lạ — chỉ nhận --apply, --unit=<đ>, --force-low-balance" };
  if (new Set(flags.map((f) => f.split("=")[0])).size !== flags.length) return { ok: false, error: "mỗi cờ chỉ một lần" };
  const apply = flags.includes("--apply");
  const force = flags.includes("--force-low-balance");
  const unitRaw = flags.find((f) => f.startsWith("--unit="))?.slice("--unit=".length);
  if ((force || unitRaw !== undefined) && !apply) return { ok: false, error: "--unit / --force-low-balance chỉ đi cùng --apply" };
  let unitVnd: number | null = null;
  if (unitRaw !== undefined) {
    if (!/^[1-9]\d{0,6}$/.test(unitRaw)) return { ok: false, error: "--unit phải là số đồng nguyên dương, ví dụ --unit=590" };
    unitVnd = Number(unitRaw);
  }
  return { ok: true, code: positional[0], apply, unitVnd, forceLowBalance: force };
}

const vnd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toLocaleString("vi-VN")}đ`);
const so = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("vi-VN"));
const usd = (v: number | null | undefined) => (v === null || v === undefined ? "không giới hạn" : `${v} USD`);
const tran = (l: AiLimits) =>
  `lượt / ngày ${so(l.requestsPerDay)} · lượt / tháng ${so(l.requestsPerMonth)} · tiền: cảnh báo ${usd(l.costUsdPerMonth.soft)} · trần cứng ${usd(l.costUsdPerMonth.hard)} · credit ${l.platformCreditUsdPerMonth} USD · ${l.softOnly ? "softOnly (credit không chặn)" : "credit là trần CỨNG của nguồn PLATFORM"}`;

/** Kế hoạch ⇒ dòng in (phần MÃ HOÁ). HÀM THUẦN. */
export function planLines(p: PrepaidPlan): string[] {
  const out: string[] = [];
  out.push(`Tổ chức ${p.orgCode}${p.orgName ? ` (${p.orgName})` : ""} · trạng thái ${p.orgStatus ?? "—"} · gói ${p.planKey ?? "—"}`);
  out.push(`Phiên bản giá đang áp: ${p.versionKey ?? "—"}${p.versionLabel ? ` «${p.versionLabel}»` : ""}${p.pinned ? " (ghim)" : " (bảng giá hiện hành — chưa ghim)"} · giá thuê bao tháng ${vnd(p.monthlyVnd)}`);
  out.push(`Tài khoản nhận tiền: ${p.receiverReady ? "ĐÃ khai" : "CHƯA khai — chủ shop cần khai ở /platform (khung «Thu phí thuê bao»)"}`);
  out.push(`Cờ Số dư AI: ${p.flagOn ? "BẬT" : "TẮT"} · số dư ${p.balance ? `${vnd(p.balance.totalVnd)} (tiền thật ${vnd(p.balance.cashVnd)} · tiền tặng ${vnd(p.balance.promoVnd)})` : "—"} · đủ ≈ ${p.hoursCovered === null ? "— (chưa ước được nhịp)" : `${p.hoursCovered} giờ`} · mức kích hoạt ${vnd(p.minActivateVnd)}`);
  out.push(`Động cơ AI Bán hàng đang lưu: ${p.engine ? `${p.engine.connectorKey} (bot ${p.engine.enabled ? "BẬT" : "TẮT"})` : "— không đọc được"}`);
  out.push(`Hoá đơn gia hạn đang mở theo giá khác trả trước: ${p.openRenewals.length ? p.openRenewals.map((r) => `${r.transferCode} [${r.priceVersionKey ?? "trước 0228"}]`).join(", ") : "không"}`);
  out.push(`Đường trừ tiền HÔM NAY: ${p.chargingNow ? `gồm ${so(p.chargingNow.included)} khách · ${vnd(p.chargingNow.unitPriceVnd)} / khách vượt (phiên bản ${p.chargingNow.priceVersionKey})` : "không trừ số dư (giá cũ không có khối khách AI / cờ tắt)"}`);
  const chua = p.period.aiCustomers !== null && p.period.charged !== null ? Math.max(0, p.period.aiCustomers - p.period.charged) : null;
  out.push(`Khách AI trong kỳ: ${so(p.period.aiCustomers)} · đã có dòng aic-charge: ${so(p.period.charged)} · CHƯA có dòng aic-charge: ${so(chua)} (khách trước lúc kích hoạt / trong phần gồm / lượt trừ hỏng — không tự bù)`);
  out.push(
    `Phiên bản «Trả trước theo khách AI»: ${p.prepaidVersionExists ? "ĐÃ có trong sổ giá" : "CHƯA có — bước KÍCH HOẠT sẽ phát hành"} · đơn giá ${p.terms ? `${vnd(p.terms.unitPriceVnd)} / khách AI (= ${vnd(p.terms.blockVnd)} / ${p.terms.blockSize} khách${p.prepaidVersionExists ? "" : ` · giá vượt ${p.terms.fromPlanName} của «${p.terms.fromVersionKey}»`})` : "—"}`,
  );
  if (p.prepaidRow) out.push(`  dòng giá gói ${p.planKey} sau khi chuyển: thuê bao tháng ${vnd(p.prepaidRow.monthlyVnd)} (giữ như giá cũ) · khách AI gồm ${so(p.prepaidRow.included.aiCustomers as number | null)} ⇒ MỌI khách AI trừ Số dư AI · không phần vượt fanpage / người dùng (như giá cũ)`);
  out.push(p.aiLimitsNow ? `Trần AI HIỆN TẠI: ${tran(p.aiLimitsNow.limits)}` : "Trần AI HIỆN TẠI: không đọc được gói");
  if (p.aiLimitsAfter) out.push(`Trần AI SAU KÍCH HOẠT (bot còn khoá riêng, credit như hiện tại): ${tran(p.aiLimitsAfter)}`);
  out.push(p.aiLimitsAfterCutover ? `Trần AI SAU org-ai-cutover --credit=${p.usage?.creditSuggestUsd}: ${tran(p.aiLimitsAfterCutover)} · CỔNG khách AI mới = SỐ DƯ AI` : "Trần AI SAU cutover: — (chưa có credit gợi ý)");
  const ghiDe = Object.entries(p.override).map(([k, v]) => `${k}=${v ?? "không giới hạn"}`);
  out.push(`Ghi đè AI của người vận hành: ${ghiDe.length ? ghiDe.join(" · ") : "không"}`);
  const u = p.usage;
  if (u) {
    out.push(`Mức dùng (ƯỚC TÍNH, 7 ngày VN trọn ${u.days7[0]} → ${u.days7[u.days7.length - 1]}):`);
    out.push(`  đồng hồ khách AI: ghi từ ${u.meterFirstDay ?? "— (chưa ghi)"} · ${u.meterFullDays} ngày trọn · ${u.meterPerDay === null ? "—" : `${u.meterPerDay} khách mới / ngày`}`);
    out.push(`  hội thoại AI có trả lời: ${u.convPerDay === null ? "—" : `${u.convPerDay} / ngày`} (cận trên: khách quay lại nhiều ngày đếm nhiều lần, còn đồng hồ tính một lần mỗi tháng)`);
    out.push(`  cơ sở: ${u.basis === "METER" ? "đồng hồ khách AI" : u.basis === "CONVERSATIONS" ? `hội thoại AI (đồng hồ mới có ${u.meterFullDays} ngày trọn — cận trên)` : "CHƯA ĐO ĐƯỢC"} ⇒ ${u.customersPerDay === null ? "—" : `${u.customersPerDay} khách AI / ngày`} × ${vnd(p.terms?.unitPriceVnd)} ≈ ${vnd(u.vndPerDay)} / ngày`);
    out.push(`  gợi ý nạp: 7 ngày ${vnd(u.topup7dVnd)} · 30 ngày ${vnd(u.topup30dVnd)} (làm tròn lên 100.000đ)`);
    out.push(`  chi phí AI Bán hàng 7 ngày (mọi nguồn, lượt đã định giá): ${u.cost7dUsd === null ? "—" : `${u.cost7dUsd} USD`} ⇒ credit gợi ý ${u.creditSuggestUsd === null ? "—" : `${u.creditSuggestUsd} USD / tháng`} (ngưỡng CẢNH BÁO; trần cứng = × 3)`);
  } else out.push("Mức dùng: không đọc được");
  for (const b of p.blockers) out.push(`CHẶN: ${b}`);
  for (const b of p.activationBlockers) out.push(`CHẶN KÍCH HOẠT: ${b}`);
  for (const w of p.warnings) out.push(`LƯU Ý: ${w}`);
  out.push(`BƯỚC KẾ TIẾP: ${PREPAID_STEP_LABEL[p.step]}`);
  if (p.step === "ACTIVATE") out.push(`Lệnh: "${p.orgCode} --apply --unit=${p.terms?.unitPriceVnd ?? "<đ>"}" rồi NGAY ops org-ai-cutover "${p.orgCode} --apply --credit=${p.usage?.creditSuggestUsd ?? "<USD>"}".`);
  if (p.step === "ACTIVE") out.push(`Nếu bot chưa ở «platform»: ops org-ai-cutover "${p.orgCode} --apply --credit=${p.usage?.creditSuggestUsd ?? "<USD>"}".`);
  return out;
}

async function main(): Promise<number> {
  const a = parsePrepaidArgs(ARGS);
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: <mã tổ chức> [--apply [--unit=<đ>] [--force-low-balance]]`);
    return 64;
  }
  if (!a.apply && !(await platformDbReadOnly())) {
    tomTat("DỪNG: kết nối CSDL nền tảng KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return 70;
  }
  const org = await findOrganization(a.code);
  if (!org) {
    tomTat("Không có tổ chức mã này");
    return 64;
  }
  const plan = await planPrepaidAi(org.code, new Date(), { forceLowBalance: a.forceLowBalance });
  for (const l of planLines(plan)) console.log(l);
  tomTat(`${a.apply ? "GHI" : "CHẠY THỬ"} ${org.code} · tài khoản nhận tiền ${plan.receiverReady ? "ĐÃ khai" : "CHƯA khai"} · cờ Số dư AI ${plan.flagOn ? "BẬT" : "TẮT"} · số dư ${plan.balance === null ? "—" : plan.balance.totalVnd > 0 ? "DƯƠNG" : "CHƯA dương"} · ${plan.onPrepaid ? "ĐÃ ở trả trước" : "chưa trả trước"} · động cơ ${plan.engine ? (plan.engine.connectorKey === "platform" ? "AI dùng chung" : "khoá riêng") : "—"}`);
  tomTat(`Bước kế tiếp: ${plan.step}${plan.blockers.length + plan.activationBlockers.length ? ` — ${plan.blockers.length + plan.activationBlockers.length} điều chặn (chi tiết trong phần mã hoá)` : ""}${!plan.receiverReady ? " — chủ shop cần khai tài khoản nhận tiền ở /platform" : ""}`);
  if (!a.apply) return plan.step === "BLOCKED" ? 1 : 0;
  const operator = { orgCode: (await listOrganizations()).find((o) => o.isHome)?.code ?? "home", email: SCRIPT_LABEL };
  const r = await applyPrepaidAiStep(org.code, operator, new Date(), { unitVnd: a.unitVnd, forceLowBalance: a.forceLowBalance });
  if ("error" in r) {
    console.log(`Không ghi: ${r.error}`);
    tomTat(`KHÔNG GHI ở bước ${r.step} (lý do trong phần mã hoá)`);
    return 1;
  }
  console.log(r.message);
  tomTat(`${r.changed ? "ĐÃ GHI" : "KHÔNG ĐỔI"} bước ${r.step} (nhật ký nền tảng nguồn SCRIPT)`);
  return 0;
}

if (CHAY_THANG) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      console.log(`LỖI: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
      tomTat("LỖI — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
