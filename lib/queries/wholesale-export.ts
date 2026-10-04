import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, type LeadSourceKey, type LeadStatus } from "@/lib/wholesale/constants";
import { formatVnPhone } from "@/lib/wholesale/phone";
import { LEAD_SEGMENT_LABEL, isLeadSegmentKey } from "@/lib/wholesale/segments";

/**
 * Dòng CSV của lead đã chọn — lọc lại bằng phạm vi dữ liệu của người tải (không tin danh sách id từ trình duyệt).
 *
 * CHỈ DỮ LIỆU CỦA TỔ CHỨC: điều khoản Google Maps Platform cấm xuất / trích nội dung Google ra ngoài dịch vụ, nên tên,
 * địa chỉ, SĐT, sao… từ snapshot Google KHÔNG vào tệp. Lead nguồn Google xuất kèm Place ID + link Google Maps (được phép)
 * và mọi trường tổ chức tự có (nhân viên nhập / xác minh, website của doanh nghiệp, tệp nhập tay, trạng thái, điểm).
 */
export async function exportWholesaleLeads(ids: string[], decision: ScopeDecision): Promise<{ header: string[]; rows: (string | number | null)[][] }> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const ps = schema.wholesalePlaceSnapshots;
  const rows = await db
    .select({
      name: l.businessName,
      segment: l.segment,
      area: l.areaName,
      province: l.provinceLabel,
      address: l.address,
      phone: l.normalizedPhone,
      website: l.website,
      email: l.email,
      facebook: l.facebookUrl,
      zalo: l.zaloUrl,
      score: l.leadScore,
      grade: l.leadGrade,
      status: l.contactStatus,
      assignee: l.assignedToName,
      source: l.source,
      mapsUrl: ps.googleMapsUri,
      placeId: l.placeId,
    })
    .from(l)
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(andScope(inArray(l.id, ids), decision))
    .limit(2000);
  const header = ["Tên (tổ chức xác nhận)", "Nhóm khách", "Khu vực", "Tỉnh / thành", "Địa chỉ (tổ chức xác nhận)", "SĐT (tổ chức xác nhận)", "Website", "Email", "Facebook", "Zalo", "Điểm", "Hạng", "Trạng thái", "Phụ trách", "Nguồn", "Google Maps", "Place ID"];
  return {
    header,
    rows: rows.map((r) => [
      r.name,
      isLeadSegmentKey(r.segment) ? LEAD_SEGMENT_LABEL[r.segment] : r.segment,
      r.area,
      r.province,
      r.address,
      r.phone ? formatVnPhone(r.phone) : null,
      r.website,
      r.email,
      r.facebook,
      r.zalo,
      r.score,
      r.grade,
      LEAD_STATUS_LABEL[r.status as LeadStatus] ?? r.status,
      r.assignee,
      LEAD_SOURCE_LABEL[r.source as LeadSourceKey] ?? r.source,
      r.mapsUrl,
      r.placeId,
    ]),
  };
}
