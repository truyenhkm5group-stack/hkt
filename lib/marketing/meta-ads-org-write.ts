import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { META_ADS_ORG_CONNECTOR, META_ADS_ORG_MAX_ACCOUNTS, META_ADS_ORG_WRITE_KEY, parseAdAccountIds, parseOrgAdsWrite } from "@/lib/constants/meta-ads-org";
import { currentOrganization } from "@/lib/platform/context";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ TOKEN GRAPH CỦA TỔ CHỨC KHÁCH CHO CỬA GHI `ads-write.ts` (chủ nền tảng chốt 04/10/2026) ═══════════
 *
 * Hải Sản Làng Chài muốn «Đăng camp» từ Thư viện Media tự lên Facebook như nhà, bằng token System User của CHÍNH BM họ.
 * Cửa ghi duy nhất (`lib/integrations/facebook/ads-write.ts`) hỏi tệp này lấy token khi ngữ cảnh không phải nhà:
 *
 *  · ĐỌC (danh sách fanpage, mẩu mẫu, tìm vị trí) — chỉ cần kết nối «meta-ads-org» đang bật.
 *  · GHI (tải ảnh, tạo bài / nhóm / mẩu, bật chiến dịch) — thêm công tắc RIÊNG của tổ chức (`ads.write.org`), quản trị của
 *    chính tổ chức bật ở tab Cấu hình & luật. Mặc định TẮT; đọc lỗi ⇒ TẮT.
 *
 * Token KHÔNG rời tệp gọi: trả về cho `ads-write.ts`, đi trong tiêu đề `Authorization`, không vào URL, không vào sổ.
 */

/** Công tắc đăng của tổ chức. Đọc THẲNG dòng (không qua `getSettingJson` — hàm đó nuốt lỗi thành "không có dòng"). */
export async function readOrgAdsWrite(): Promise<{ enabled: boolean; error: string | null }> {
  try {
    const db = await getDb();
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, META_ADS_ORG_WRITE_KEY)).limit(1);
    return { enabled: parseOrgAdsWrite(row?.value ?? null).enabled, error: null };
  } catch (e) {
    return { enabled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type OrgGraphCredential = { ok: true; org: string; token: string; adAccountIds: string[] } | { ok: false; reason: string };

export async function openOrgGraphCredential(purpose: "READ" | "WRITE"): Promise<OrgGraphCredential> {
  const org = await currentOrganization();
  if (org.isHome) return { ok: false, reason: "tổ chức nhà dùng token môi trường, không dùng kết nối của tổ chức." };
  if (purpose === "WRITE") {
    const w = await readOrgAdsWrite();
    if (w.error) return { ok: false, reason: `không đọc được công tắc đăng quảng cáo của tổ chức (${w.error}) — coi như TẮT.` };
    if (!w.enabled) return { ok: false, reason: "tổ chức chưa bật «Cho ERP đăng quảng cáo bằng token của tổ chức» (Marketing → Creative → Cấu hình & luật)." };
  }
  const conn = await openActiveConnection(META_ADS_ORG_CONNECTOR);
  if (!conn.ok) return { ok: false, reason: conn.reason };
  const token = (conn.secrets.accessToken ?? "").trim();
  if (!token) return { ok: false, reason: "kết nối «Quảng cáo Facebook (Meta) của tổ chức» chưa có token." };
  const { ids } = parseAdAccountIds(conn.settings.adAccountIds);
  if (!ids.length) return { ok: false, reason: "kết nối «Quảng cáo Facebook (Meta) của tổ chức» chưa khai tài khoản quảng cáo hợp lệ nào." };
  return { ok: true, org: org.code, token, adAccountIds: ids.slice(0, META_ADS_ORG_MAX_ACCOUNTS) };
}

/** Lý do tổ chức ngữ cảnh CHƯA đăng được bằng token của mình — `null` = được, hoặc là nhà (nhà đi chốt env như cũ). */
export async function orgAdsWriteBlocker(): Promise<string | null> {
  const org = await currentOrganization();
  if (org.isHome) return null;
  const c = await openOrgGraphCredential("WRITE");
  return c.ok ? null : `Đăng quảng cáo của tổ chức đang đóng — ${c.reason}`;
}

/** Bật / tắt công tắc đăng của tổ chức. Cần `settings:manage`; ghi nhật ký trước/sau. Tổ chức nhà không có công tắc này. */
export async function saveOrgAdsWriteCore(user: SessionUser, enabled: boolean): Promise<{ ok: true; enabled: boolean } | { error: string }> {
  const org = await currentOrganization();
  if (org.isHome) return { error: "Tổ chức nhà đi chốt máy chủ ADS_WRITE_ENABLED — không có công tắc này." };
  if (!can(user, "settings:manage")) return { error: "Cần quyền cấu hình (settings:manage) để bật / tắt đăng quảng cáo." };
  const before = await readOrgAdsWrite();
  const next = enabled === true;
  await setSettingJson(META_ADS_ORG_WRITE_KEY, { enabled: next });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORG_ADS_WRITE_TOGGLE",
    entity: "SETTINGS",
    entityId: META_ADS_ORG_WRITE_KEY,
    before: { enabled: before.enabled },
    after: { enabled: next },
    reason: next ? "Cho ERP đăng quảng cáo bằng token System User của tổ chức" : "Tắt đăng quảng cáo bằng token của tổ chức",
  });
  return { ok: true, enabled: next };
}
