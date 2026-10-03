/**
 * KIỂM CHỨNG THẬT: MẨU QUẢNG CÁO → CREATIVE → BÀI VIẾT trên token Meta của production.
 *
 * Chạy ĐÚNG hàm mà màn hình `/ads/post-resolver` gọi (`resolveAdPosts` qua `FacebookAdsClient`), nên
 * một lượt xanh ở đây là bằng chứng đường thật chạy — không phải một bản mô phỏng bằng lời.
 *
 *   npx tsx scripts/meta-ad-post-probe.ts 120248409213230618 [mã khác…]      # CHỈ ĐỌC Meta
 *   npx tsx scripts/meta-ad-post-probe.ts 120248409213230618 --apply        # + ghi vào fb_ads (cùng hàm nút "Đồng bộ")
 *   npx tsx scripts/meta-ad-post-probe.ts https://fb.me/adspreview/facebook/<mã>   # link chia sẻ → dò Ad ID → bài
 *
 * LOG CỦA OPS LÀ CÔNG KHAI (kho PUBLIC): mọi mã in ở dạng ĐÃ CHE (4 số cuối), không in tên quảng cáo,
 * tên fanpage, permalink hay câu lỗi thô — chỉ trạng thái, nguồn, và CÓ / KHÔNG. Người cần giá trị đầy
 * đủ mở màn hình trong ERP. Không in token (AGENTS.md mục 5).
 */
import "dotenv/config";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { resolveAdPosts } from "@/lib/integrations/facebook/ad-post-resolver";
import { erpFanpageNames, loadAdPostErpContext, saveAdPostResolutions } from "@/lib/integrations/facebook/ad-post-store";
import { findAdsByPreviewLinks } from "@/lib/integrations/facebook/ad-preview-link";
import { parseAdIdList } from "@/lib/constants/meta-ad-post";

const che = (v: string | null | undefined) => (v ? `…${v.slice(-4)}` : "—");

/** fb.me/<mã> → đích chuyển hướng (CHỈ đọc header Location, không đọc thân trang, không đăng nhập). */
async function redirectTarget(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0" } });
    const loc = res.headers.get("location") ?? "";
    const enc = /[?&]encrypted_experience_id=([^&]+)/.exec(loc)?.[1];
    return enc ? `E:${enc}` : `HTTP${res.status}:${loc.slice(0, 40)}`;
  } catch (e) {
    return `LOI:${e instanceof Error ? e.name : "?"}`;
  }
}

/**
 * ĐO GIẢ THUYẾT (cờ `--redirect`, tuỳ chọn `--account=<id>`): mã của hộp "Chia sẻ" khác mã API trả cho
 * cùng mẩu (lượt dò 03/10/2026 không khớp 0/2.878). Hai mã có cùng chuyển về MỘT `encrypted_experience_id`
 * không? Đo ba điều: API trả mã ỔN ĐỊNH qua hai lần đọc không · đích chuyển hướng có ỔN ĐỊNH không · đích
 * của link người dán có trùng đích của link API của mẩu nào không. Chỉ in CÓ/KHÔNG và mã đã che.
 */
async function redirectExperiment(graph: ReturnType<typeof getFacebookAdsClient>, links: { url: string; code: string }[], accountArg: string | undefined) {
  const accounts = await graph.listAdAccounts();
  const ids = accounts.map((a) => a.accountId);
  console.log(`[ops:tom-tat] tài khoản ERP đọc được: ${ids.map(che).join(" ")} · tài khoản yêu cầu ${che(accountArg)} có trong đó: ${accountArg ? (ids.includes(accountArg) ? "có" : "KHÔNG") : "—"}`);
  const userTargets = new Map<string, string>();
  for (const l of links) {
    const a = await redirectTarget(l.url);
    const b = await redirectTarget(l.url);
    userTargets.set(a, l.code);
    console.log(`[ops:tom-tat] link người dán …${l.code.slice(-4)} → đích ${a.slice(0, 2)} · hai lần như nhau: ${a === b ? "có" : "KHÔNG"}`);
  }
  const order = accountArg && ids.includes(accountArg) ? [accountArg] : ids;
  let checked = 0;
  let sampled = 0;
  for (const accountId of order) {
    for await (const page of graph.adPreviewLinkPages(accountId)) {
      for (const ad of page) {
        if (!ad.link || checked >= 1500) continue;
        checked += 1;
        const target = await redirectTarget(ad.link);
        if (sampled < 3) {
          sampled += 1;
          const again = await graph.readNode(ad.adId, "preview_shareable_link");
          const link2 = again.kind === "node" ? String(again.node.preview_shareable_link ?? "") : "";
          const target2 = await redirectTarget(ad.link);
          console.log(`[ops:tom-tat] mẫu ad ${che(ad.adId)}: link API hai lần đọc như nhau: ${link2 === ad.link ? "có" : "KHÔNG"} · đích ${target.slice(0, 2)} hai lần như nhau: ${target === target2 ? "có" : "KHÔNG"}`);
        }
        const hit = userTargets.get(target);
        if (hit) console.log(`[ops:tom-tat] KHỚP ĐÍCH: link người dán …${hit.slice(-4)} = link API của ad ${che(ad.adId)} (tài khoản ${che(accountId)}) · mã hai link như nhau: ${ad.link.endsWith(hit) ? "có" : "KHÔNG"}`);
      }
      if (checked >= 1500) break;
    }
  }
  console.log(`[ops:tom-tat] đã so đích chuyển hướng của ${checked} link API.`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const list = parseAdIdList(args.filter((a) => !a.startsWith("--")).join("\n"));
  if (!list.adIds.length && !list.previewLinks.length) {
    console.log("[ops:tom-tat] Không có Ad ID / link chia sẻ fb.me/adspreview hợp lệ trong ô arg.");
    process.exit(2);
  }
  const graph = getFacebookAdsClient();
  const adIds = [...list.adIds];
  if (args.includes("--redirect")) {
    await redirectExperiment(graph, list.previewLinks, args.find((a) => a.startsWith("--account="))?.slice("--account=".length));
    process.exit(0);
  }
  if (list.previewLinks.length) {
    // Cùng đường của màn hình: tài khoản đang hoạt động dò trước, so theo (loại link, mã).
    const accounts = await graph.listAdAccounts();
    const accountIds = [...accounts].sort((a, b) => Number(b.status === 1) - Number(a.status === 1)).map((a) => a.accountId);
    const scan = await findAdsByPreviewLinks(list.previewLinks, { graph, accountIds });
    const f = scan.linkForms;
    console.log(
      `[ops:tom-tat] dò link chia sẻ: ${scan.scannedAds} mẩu · ${scan.scannedAccounts}/${scan.totalAccounts} tài khoản · chạm trần: ${scan.capped ? "có" : "không"}` +
        ` · lỗi tài khoản: ${scan.accountErrors.map((e) => e.error).join(",") || "0"} · dừng: ${scan.fatal ?? "không"}` +
        ` · Meta trả link dạng facebook ${f.facebook} · managedaccount ${f.managedAccount} · rỗng ${f.empty} · lạ ${f.other}`,
    );
    for (const m of scan.matches) {
      console.log(`[ops:tom-tat] link ${m.link.audience} …${m.link.code.slice(-4)} → ${m.adId ? `ad ${che(m.adId)} (tài khoản ${che(m.accountId)})` : `CHƯA THẤY: ${m.reason}`}`);
      if (m.adId && !adIds.includes(m.adId)) adIds.push(m.adId);
    }
  }
  if (!adIds.length) process.exit(0);
  const rows = await resolveAdPosts(adIds, { graph, erpPageNames: (ids) => erpFanpageNames(ids) });
  const erpNames = await erpFanpageNames(rows.map((r) => r.pageId ?? "").filter(Boolean));
  for (const r of rows) {
    console.log(
      `[ops:tom-tat] ad ${che(r.adId)} · ${r.ok ? "RA BÀI" : `LỖI ${r.error}`}` +
        ` · mẩu đọc được: ${r.adFound ? "có" : "không"}` +
        ` · creative ${che(r.creativeId)} · page ${che(r.pageId)} · post ${che(r.postId)}` +
        ` · nguồn ${r.resolutionSource ?? "—"}` +
        ` · page có trong sổ fanpage ERP: ${r.pageId ? (erpNames.has(r.pageId) ? "có" : "không") : "—"}` +
        ` · tên trang: ${r.pageNameSource ?? "không đọc được"} · permalink Meta: ${r.permalinkUrl ? "có" : "không"}` +
        (r.graphError ? ` · Graph mã ${r.graphError.code ?? "?"}/${r.graphError.subcode ?? "-"} trace ${r.graphError.fbtraceId || "-"}` : ""),
    );
  }
  if (apply) {
    const saved = await saveAdPostResolutions(rows);
    console.log(`[ops:tom-tat] GHI fb_ads: ${saved.inserted} mới · ${saved.updated} cập nhật · ${saved.unchanged} không đổi · ${saved.skipped.length} bỏ qua`);
    const again = await saveAdPostResolutions(rows);
    console.log(`[ops:tom-tat] ghi LẠI cùng kết quả (idempotent): ${again.inserted} mới · ${again.updated} cập nhật · ${again.unchanged} không đổi`);
    const ctx = await loadAdPostErpContext(rows.map((r) => ({ adId: r.adId, storyId: r.objectStoryId })));
    for (const r of rows) {
      const c = ctx.get(r.adId);
      console.log(`[ops:tom-tat] ERP sau ghi: ad ${che(r.adId)} · bài đã lưu ${che(c?.stored?.postId)} · khớp kết quả tra: ${c?.stored?.storyId && c.stored.storyId === r.objectStoryId ? "có" : "không"} · mẫu vòng mẫu nối tới: ${c?.creativeVariantIds.length ?? 0}`);
    }
  }
  const ok = rows.filter((r) => r.ok).length;
  console.log(`[ops:tom-tat] Tổng: ${ok}/${rows.length} mẩu ra được bài viết${apply ? " (đã ghi)" : " (CHỈ ĐỌC, chưa ghi)"}.`);
  process.exit(0);
}

main().catch((e) => {
  // Câu lỗi đã đi qua graphErrorInfo ở đường tra; lỗi ngoài đó (CSDL, cấu hình) in tên lỗi, không in URL.
  console.error(`[ops:tom-tat] Lỗi: ${e instanceof Error ? e.name + ": " + e.message.replace(/access_token=[^&\s]+/gi, "access_token=***").slice(0, 200) : String(e)}`);
  process.exit(1);
});
