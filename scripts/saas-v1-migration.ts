/*
  ops `saas-v1-migration` — CHUYỂN TỔ CHỨC TỪ GIÁ CŨ (LEGACY) SANG BẢNG GIÁ V1 (docs/saas/V1_MIGRATION.md · lõi lib/pricing/migration.ts).

  Vì sao (08/10/2026, chủ shop): «chuyển các tổ chức từ giá cũ sang bảng giá V1 — làm theo phương án tốt nhất». 8/8 tổ chức khách
  đang ghim `legacy` ⇒ không tổ chức nào phát sinh được phần vượt. Phương án tốt nhất = có SỐ trước khi ghi, MỘT tổ chức mỗi lần,
  không bất ngờ cho khách, và chỉ đổi GIÁ THAM CHIẾU (không bật thu phí, không hoá đơn, không dùng thử).

  Hai chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thiếu / thừa ⇒ lỗi cách dùng (mã 64), không đoán:
   · (rỗng) | `--org=<mã>`     CHẠY THỬ (CHỈ ĐỌC — script đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc): mọi tổ chức (hoặc một),
                               tổ chức bị loại kèm lý do; tổ chức đủ điều kiện: phiên bản / gói hiện tại · số dùng (fanpage · người dùng ·
                               khách AI 30 ngày: đồng hồ + ước từ sổ AI) · gói V1 đề xuất (`smallestFittingPlan`) · giá cũ → mới · phần
                               vượt dự kiến · cờ thu phí · trần AI trước / sau (BYOK + AI dùng chung) · tính năng mất · mọi CHẶN.
   · `--apply --org=<mã> --plan=<khoá> --reason=<lý do…> [--accept-overage] [--accept-billing-on] [--accept-lower-limits]`
                               GHIM tổ chức đó vào gói chỉ định của bảng giá hiện hành qua `applyV1Migration` (cột gói + ghim phiên bản +
                               nhật ký nền tảng ORG_PLAN_SET / PRICE_VERSION_PIN nguồn SCRIPT). Lý do = mọi từ sau `--reason=` tới cờ kế
                               tiếp. Chặn nào còn lại ⇒ KHÔNG ghi gì (mã 65). Workspace NHÀ không bao giờ ghim ở đây
                               (gói thường cho nhà: scripts/pricing-internal-fit.ts).

  Cả lượt chạy trong `ma_hoa_ket_qua`: số dùng, giá, phần vượt của khách CHỈ nằm ở phần MÃ HOÁ; dòng `[ops:tom-tat] ` (log công khai —
  kho PUBLIC) chỉ mang mã tổ chức ĐỌC TỪ SỔ (không bao giờ nội dung ô arg), nhãn và phán quyết (đủ điều kiện / bị loại · gói đề xuất ·
  CHUYỂN ĐƯỢC / BỊ CHẶN + mã chặn). Lỗi cách dùng chỉ nói VỊ TRÍ / LOẠI lỗi.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("saas-v1-migration.ts"));
if (CHAY_THANG && !ARGS.includes("--apply")) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { applyV1Migration, planV1Migration, platformReadOnlyConfirmed, remainingBlockers, V1_MIGRATION_EMAIL, type V1Assessment, type V1OrgPlan } from "@/lib/pricing/migration";
import { METER_COVERAGE_LABEL } from "@/lib/pricing/versions";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const vnd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toLocaleString("vi-VN")} ₫`);
const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("vi-VN"));

export type V1Args = { ok: true; apply: boolean; org: string | null; plan: string | null; reason: string | null; acceptOverage: boolean; acceptBillingOn: boolean; acceptLowerLimits: boolean } | { ok: false; error: string };

const FLAGS = new Set(["--apply", "--accept-overage", "--accept-billing-on", "--accept-lower-limits"]);
const VALUED = ["--org=", "--plan=", "--reason="] as const;

/**
 * Đọc ô arg (đã tách theo khoảng trắng). Lý do = mọi từ sau `--reason=` tới cờ kế tiếp. THUẦN. Câu lỗi chỉ nói VỊ TRÍ / LOẠI lỗi,
 * KHÔNG chép nội dung ô arg — nó đi ra kênh tóm tắt (log công khai).
 */
export function parseV1Args(args: readonly string[]): V1Args {
  let org: string | null = null;
  let plan: string | null = null;
  let reason: string[] | null = null;
  const seen = new Set<string>();
  let inReason = false;
  for (const [i, a] of args.entries()) {
    if (inReason && !a.startsWith("--")) {
      reason!.push(a);
      continue;
    }
    inReason = false;
    const valued = VALUED.find((p) => a.startsWith(p));
    const key = valued ?? a;
    if (seen.has(key)) return { ok: false, error: `từ thứ ${i + 1}: cờ lặp lại` };
    seen.add(key);
    if (valued === "--org=") org = a.slice(valued.length).trim() || null;
    else if (valued === "--plan=") plan = a.slice(valued.length).trim() || null;
    else if (valued === "--reason=") {
      reason = [a.slice(valued.length)].filter(Boolean);
      inReason = true;
    } else if (!FLAGS.has(a)) return { ok: false, error: `từ thứ ${i + 1}: không phải cờ đã biết` };
  }
  const apply = seen.has("--apply");
  const acceptOverage = seen.has("--accept-overage");
  const acceptBillingOn = seen.has("--accept-billing-on");
  const acceptLowerLimits = seen.has("--accept-lower-limits");
  if (org !== null && !/^[a-z][a-z0-9-]{1,30}$/.test(org)) return { ok: false, error: "mã tổ chức không hợp lệ" };
  if (!apply && (plan !== null || reason !== null || acceptOverage || acceptBillingOn || acceptLowerLimits)) return { ok: false, error: "--plan / --reason / --accept-* chỉ đi cùng --apply" };
  if (apply && (!org || !plan)) return { ok: false, error: "--apply cần --org=<mã> và --plan=<khoá> (một tổ chức mỗi lần)" };
  const reasonText = reason ? reason.join(" ").trim() : null;
  if (apply && (!reasonText || reasonText.length < 5)) return { ok: false, error: "--apply cần --reason=<lý do, ít nhất 5 ký tự>" };
  return { ok: true, apply, org, plan, reason: reasonText, acceptOverage, acceptBillingOn, acceptLowerLimits };
}

const OVERRIDE_FLAG = { ACCEPT_OVERAGE: "--accept-overage", ACCEPT_BILLING_ON: "--accept-billing-on", ACCEPT_LOWER_LIMITS: "--accept-lower-limits" } as const;
type Accept = { overage: boolean; billingOn: boolean; lowerLimits: boolean };
const NO_ACCEPT: Accept = { overage: false, billingOn: false, lowerLimits: false };

function blockerLines(a: V1Assessment, accept: Accept): string[] {
  const left = remainingBlockers(a, accept);
  return a.blockers.map((b) => `    ${left.includes(b) ? "CHẶN" : "đã chấp nhận"} [${b.code}${b.override ? ` · vượt được bằng ${OVERRIDE_FLAG[b.override]}` : ""}] ${b.message}`);
}

/** Dòng báo cáo của MỘT tổ chức: `pub` = kênh tóm tắt (log công khai), `priv` = phần mã hoá. THUẦN. */
export function formatV1Row(r: V1OrgPlan): { pub: string[]; priv: string[] } {
  const pub: string[] = [];
  const priv: string[] = [];
  if (!r.eligible) {
    pub.push(`${r.code}: BỊ LOẠI (${r.exclusion})`);
    priv.push(`■ ${r.code} — ${r.name}: BỊ LOẠI — ${r.note}`);
    if (!r.facts) return { pub, priv };
  }
  const f = r.facts!;
  const u = f.usage;
  const ac = u.aiCustomers;
  if (r.eligible) priv.push(`■ ${r.code} — ${r.name}`);
  else priv.push("  (chỉ để xem — workspace NHÀ, INTERNAL_CHARGEBACK, không thu tiền, không ghim qua script này)");
  priv.push(`  Hiện tại: phiên bản ${r.versionKey ?? "—"}${f.pinKey ? " (ghim)" : " (chưa ghim)"} · gói ${r.planKey} · giá tháng ${vnd(f.currentPrice?.monthlyVnd ?? null)} · thu phí ${f.billing.enabled ? `BẬT (trả tới ${f.billing.paidThrough ?? "—"})` : "TẮT"} · hoá đơn đang mở ${f.billing.openInvoices} · Số dư AI ${f.aiBalanceOn ? "BẬT" : "tắt"}`);
  priv.push(`  Số dùng: fanpage đang nối ${num(u.fanpages)} · người dùng hoạt động ${num(u.users)} · cần AI bán hàng ${u.needsAiSales ? "có" : "không"}${Object.keys(f.addons).length ? ` · đã mua thêm ${JSON.stringify(f.addons)}` : ""}`);
  const ent = f.entitlements;
  if (ent.counts && ent.before) priv.push(`  Trần kỹ thuật hôm nay (đang dùng / trần): ${Object.entries(ent.counts).map(([k, n]) => `${k} ${num(n)}/${ent.before![k as keyof typeof ent.before] === null ? "∞" : num(ent.before![k as keyof typeof ent.before])}`).join(" · ")} · nhịp luật ${ent.cadenceBeforeMinutes} phút`);
  priv.push(`  Khách AI 30 ngày: đồng hồ ${num(ac.meter)} (${METER_COVERAGE_LABEL[ac.meterCoverage]}${ac.meterNote ? ` — ${ac.meterNote}` : ""}) · sổ AI ${num(ac.ledgerConversations)} hội thoại có lượt AI bán hàng${ac.ledgerUnattributed ? ` (+${ac.ledgerUnattributed} lượt không mã hội thoại)` : ""} ⇒ số chọn gói ${num(ac.basis)} — ${ac.basisNote}`);
  if (f.readErrors.length) priv.push(`  Lỗi đọc: ${f.readErrors.join(" · ")}`);
  for (const c of r.fit?.candidates ?? []) priv.push(`    ${c.fits ? "✓" : "✗"} ${c.name} ${vnd(c.monthlyVnd)}${c.why.length ? ` — ${c.why.join("; ")}` : ""}`);
  priv.push(`  Đề xuất: ${r.fit?.plan ? `«${r.fit.plan.name}» (${r.fit.plan.planKey})` : "CHƯA chọn được gói"} — ${r.fit?.reason ?? "—"}`);
  if (r.floor?.plan) priv.push(`  Cận dưới (chỉ theo fanpage + người dùng, CHƯA tính khách AI): «${r.floor.plan.name}» ${vnd(r.floor.plan.monthlyVnd)} — không phải đề xuất.`);
  const p = r.proposal;
  if (p && p.target) {
    priv.push(`  Giá tham chiếu: ${vnd(p.priceBeforeVnd)} → ${vnd(p.priceAfterVnd)}/tháng · phần vượt dự kiến (ước) ${p.overage?.totalVnd === null || p.overage === null ? `chưa biết (đã biết ${vnd(p.overage?.knownVnd ?? 0)})` : vnd(p.overage.totalVnd)}`);
    if (p.aiBefore && p.aiAfter) priv.push(`  Trần AI trước → sau: khoá riêng (BYOK) ${p.aiBefore.BYOK.ok ? "cho" : `CHẶN ${p.aiBefore.BYOK.reason}`} → ${p.aiAfter.BYOK.ok ? "cho" : `CHẶN ${p.aiAfter.BYOK.reason}`} · AI dùng chung ${p.aiBefore.PLATFORM.ok ? "cho" : `CHẶN ${p.aiBefore.PLATFORM.reason}`} → ${p.aiAfter.PLATFORM.ok ? "cho" : `CHẶN ${p.aiAfter.PLATFORM.reason}`}`);
    if (p.featuresLost.length) priv.push(`  Tính năng mất: ${p.featuresLost.join(", ")}`);
    if (p.limitsAfter) priv.push(`  Trần kỹ thuật sau khi ghim: ${Object.entries(p.limitsAfter).map(([k, n]) => `${k} ${n === null ? "∞" : num(n)}`).join(" · ")}`);
    for (const w of p.warnings) priv.push(`  Lưu ý: ${w}`);
    priv.push(...blockerLines(p, NO_ACCEPT));
  }
  if (!r.eligible) return { pub, priv };
  const blocked = p ? p.blockers.map((b) => b.code) : [];
  const verdict = !r.fit?.plan ? "CHƯA ĐỀ XUẤT" : blocked.length ? `BỊ CHẶN (${[...new Set(blocked)].join(", ")})` : "CHUYỂN ĐƯỢC";
  pub.push(`${r.code}: đủ điều kiện · đề xuất ${r.fit?.plan?.planKey ?? "—"} · ${verdict}`);
  return { pub, priv };
}

async function dryRun(orgCode: string | null): Promise<number> {
  if (!(await platformReadOnlyConfirmed())) {
    tomTat("DỪNG: kết nối CSDL nền tảng KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return 70;
  }
  const r = await planV1Migration({ orgCode: orgCode ?? undefined });
  tomTat(`CHẠY THỬ (CHỈ ĐỌC) · bảng giá hiện hành ${r.catalogKey ?? "—"} · ${r.rows.length} tổ chức · ${r.rows.filter((x) => x.eligible).length} đủ điều kiện`);
  for (const row of r.rows) {
    const out = formatV1Row(row);
    out.pub.forEach(tomTat);
    out.priv.forEach((l) => console.log(l));
  }
  return 0;
}

async function main(): Promise<number> {
  const a = parseV1Args(ARGS);
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: [--org=<mã>] | --apply --org=<mã> --plan=<khoá> --reason=<lý do> [--accept-overage] [--accept-billing-on] [--accept-lower-limits]`);
    return 64;
  }
  if (!a.apply) return dryRun(a.org);
  const accept: Accept = { overage: a.acceptOverage, billingOn: a.acceptBillingOn, lowerLimits: a.acceptLowerLimits };
  const r = await applyV1Migration({ orgCode: a.org!, planKey: a.plan!, reason: a.reason!, acceptOverage: a.acceptOverage, acceptBillingOn: a.acceptBillingOn, acceptLowerLimits: a.acceptLowerLimits, source: "SCRIPT", email: V1_MIGRATION_EMAIL });
  if (r.assessment) console.log(blockerLines(r.assessment, accept).join("\n"));
  console.log(r.message);
  // Kênh tóm tắt KHÔNG nhắc mã tổ chức / gói của ô arg — chỉ phán quyết và mã chặn.
  const codes = r.assessment ? [...new Set(remainingBlockers(r.assessment, accept).map((b) => b.code))] : [];
  tomTat(`GHIM: ${r.applied ? "ĐÃ GHIM (thu phí không đổi, không hoá đơn, không dùng thử)" : `KHÔNG GHI (${codes.join(", ") || "xem phần mã hoá"})`}`);
  return r.applied ? 0 : 65;
}

if (CHAY_THANG) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      console.log(`LỖI: ${e instanceof Error ? e.message : String(e)}`);
      tomTat("LỖI — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
