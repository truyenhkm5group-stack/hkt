/**
 * ═══════════ SỔ VĂN BẢN PHÁP LÝ — TERMS · PRIVACY · DPA (docs/legal/TECH_HANDOFF_LEGAL.md M-ACCEPT) — CHỈ MÁY CHỦ ═══════════
 *
 * Một dòng cho mỗi văn bản khách thuê chấp thuận. Phiên bản / ngày hiệu lực / đường dẫn KHÔNG gõ lại ở đây: đọc từ
 * `lib/constants/company.ts` (`TERMS_OF_SERVICE`, `PRIVACY_POLICY`) — đó là nơi trang và nhật ký `ORG_ONBOARDED` đã đọc,
 * nên một chỗ sửa là đủ.
 *
 * ─── BĂM NỘI DUNG — `legalContentSha256(document, version)` ───
 * Băm ĐÚNG cây nội dung mà trang dựng (`components/legal/terms-content.tsx`, `privacy-content.tsx`): trang và hàm băm đọc
 * CÙNG một hằng, không có bản chép thứ hai để lệch. Cây được mở ra như React mở (thành phần hàm được gọi, Fragment bị
 * làm phẳng) rồi chuẩn hoá: thẻ + thuộc tính có nghĩa (href, id…) + chữ. `className` / `style` KHÔNG vào băm — đổi màu
 * chữ không phải đổi văn bản; đổi một chữ, một liên kết hay một con số hằng (`TRIAL_DAYS`…) thì băm đổi. Không dùng
 * `react-dom/server` (bị cấm trong lớp Server Component của Next), nên hàm gọi được từ server action ghi sổ (việc L2).
 *
 * `LEGAL_DOCUMENTS[k].contentSha256` GHIM băm của phiên bản đang công bố. Bài kiểm (`tests/legal-registers.test.ts`)
 * so ghim với băm tính lại: sửa chữ mà không tăng phiên bản ⇒ ĐỎ. Đó là bất biến sổ chấp thuận cần: CÙNG phiên bản ⇔
 * CÙNG nội dung. Phiên bản cũ không giữ nội dung trong mã (chỉ còn ở lịch sử git) ⇒ hàm trả `null`, không đoán.
 *
 * DPA: CHƯA CÓ VĂN BẢN. Trạng thái `NOT_PUBLISHED` + `COUNSEL_PENDING`; không bịa phiên bản, không bịa đường dẫn.
 */
import { createHash } from "node:crypto";
import { Fragment, isValidElement, type ReactNode } from "react";
import type { LegalDocumentContent } from "@/components/legal/legal-blocks";
import { PRIVACY_CONTENT } from "@/components/legal/privacy-content";
import { TERMS_CONTENT } from "@/components/legal/terms-content";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";

export const LEGAL_DOCUMENT_KEYS = ["TERMS", "PRIVACY", "DPA"] as const;
export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_KEYS)[number];

/** Văn bản đã công bố trên trang công khai, hay chưa có văn bản nào. */
export const LEGAL_PUBLICATION_STATES = ["PUBLISHED", "NOT_PUBLISHED"] as const;
export type LegalPublicationState = (typeof LEGAL_PUBLICATION_STATES)[number];

/** Luật sư đã rà bằng văn bản chưa. Hôm nay KHÔNG văn bản nào đã được rà (VIETNAM_LEGAL_COMPLIANCE.md §16, G-9). */
export const LEGAL_COUNSEL_STATES = ["COUNSEL_PENDING", "COUNSEL_REVIEWED"] as const;
export type LegalCounselState = (typeof LEGAL_COUNSEL_STATES)[number];

type PublishedLegalDocument = {
  key: LegalDocumentKey;
  name: string;
  publication: "PUBLISHED";
  counsel: LegalCounselState;
  version: string;
  effective: string;
  path: string;
  /** Tệp chứa câu chữ — trang và hàm băm cùng đọc. */
  contentSource: string;
  content: LegalDocumentContent;
  /** Băm của phiên bản `version` — GHIM; bài kiểm so với băm tính lại. */
  contentSha256: string;
};

type UnpublishedLegalDocument = {
  key: LegalDocumentKey;
  name: string;
  publication: "NOT_PUBLISHED";
  counsel: LegalCounselState;
  version: null;
  effective: null;
  path: null;
  /** Dự định sẽ là gì, ở đâu — để không ai dựng một trang / một bước ký riêng ngoài thiết kế đã chốt. */
  plannedAs: string;
  /** Ai phải làm gì trước khi có văn bản (F chủ sở hữu · G luật sư — VIETNAM_LEGAL_COMPLIANCE.md §19). */
  blockedBy: readonly string[];
};

export type LegalDocument = PublishedLegalDocument | UnpublishedLegalDocument;

export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentKey, LegalDocument>> = {
  TERMS: {
    key: "TERMS",
    name: "Điều khoản sử dụng",
    publication: "PUBLISHED",
    counsel: "COUNSEL_PENDING",
    version: TERMS_OF_SERVICE.version,
    effective: TERMS_OF_SERVICE.effective,
    path: TERMS_OF_SERVICE.path,
    contentSource: "components/legal/terms-content.tsx",
    content: TERMS_CONTENT,
    contentSha256: "d9fd2c514d91a0d06a3e89f479e3e2e2e297a2aef80168593904387d46920c1e",
  },
  PRIVACY: {
    key: "PRIVACY",
    name: "Chính sách quyền riêng tư",
    publication: "PUBLISHED",
    counsel: "COUNSEL_PENDING",
    version: PRIVACY_POLICY.version,
    effective: PRIVACY_POLICY.effective,
    path: PRIVACY_POLICY.path,
    contentSource: "components/legal/privacy-content.tsx",
    content: PRIVACY_CONTENT,
    contentSha256: "ef8641afd988a6d6d55704304286d05bdcbbf19675652f75e0b83405a510477f",
  },
  DPA: {
    key: "DPA",
    name: "Thoả thuận xử lý dữ liệu (Bên Kiểm soát — khách thuê · Bên Xử lý — VNX)",
    publication: "NOT_PUBLISHED",
    counsel: "COUNSEL_PENDING",
    version: null,
    effective: null,
    path: null,
    plannedAs:
      "Phụ lục A của Điều khoản sử dụng, chấp thuận cùng dòng đồng ý hiện có ở /start — không màn hình, bước hay cú bấm mới (M-DPA-ANNEX, CONVERSION_FIRST_REAUDIT.md P0-5). Khung nháp: DATA_PROCESSING_REGISTER.md §6.",
    blockedBy: ["F: chủ sở hữu duyệt phụ lục", "G: luật sư soạn nội dung từ khung §6", "G-10: phụ lục chấp thuận một lần có đủ không"],
  },
};

// ─────────────────────────── Chuẩn hoá cây nội dung ───────────────────────────

/** Một nút đã chuẩn hoá: chữ, hoặc thẻ HTML với thuộc tính có nghĩa và con. */
export type CanonicalLegalNode = string | { tag: string; attrs: Record<string, string | number | boolean>; children: CanonicalLegalNode[] };

/** Thuộc tính TRÌNH BÀY — không phải nội dung văn bản, không vào băm. */
const PRESENTATION_PROPS: ReadonlySet<string> = new Set(["children", "className", "style", "key"]);

function pushText(out: CanonicalLegalNode[], text: string) {
  const last = out[out.length - 1];
  if (typeof last === "string") out[out.length - 1] = last + text;
  else out.push(text);
}

function walk(node: ReactNode, out: CanonicalLegalNode[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return pushText(out, String(node));
  if (Array.isArray(node)) {
    for (const n of node) walk(n as ReactNode, out);
    return;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    const { type } = node;
    if (type === Fragment) return walk(props.children as ReactNode, out);
    if (typeof type === "function") {
      const rendered: unknown = (type as (p: Record<string, unknown>) => unknown)(props);
      if (rendered !== null && typeof rendered === "object" && typeof (rendered as { then?: unknown }).then === "function") {
        throw new Error("Nội dung văn bản pháp lý chứa thành phần BẤT ĐỒNG BỘ — nội dung phải dựng được không cần yêu cầu HTTP / CSDL.");
      }
      return walk(rendered as ReactNode, out);
    }
    if (typeof type === "string") {
      const attrs: Record<string, string | number | boolean> = {};
      for (const k of Object.keys(props).sort()) {
        if (PRESENTATION_PROPS.has(k)) continue;
        const v = props[k];
        if (v === undefined) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") attrs[k] = v;
        else throw new Error(`Thuộc tính «${k}» của <${type}> không phải giá trị tĩnh — nội dung văn bản pháp lý phải tĩnh.`);
      }
      const children: CanonicalLegalNode[] = [];
      walk(props.children as ReactNode, children);
      out.push({ tag: type, attrs, children });
      return;
    }
  }
  throw new Error("Nội dung văn bản pháp lý chứa một nút không chuẩn hoá được — chỉ chữ, thẻ HTML, Fragment và thành phần hàm đồng bộ.");
}

/** Chuẩn hoá một cây nội dung (thuần, không đọc gì ngoài cây). */
export function canonicalLegalTree(node: ReactNode): CanonicalLegalNode[] {
  const out: CanonicalLegalNode[] = [];
  walk(node, out);
  return out;
}

/** Băm một nội dung bất kỳ theo đúng công thức của sổ — tách riêng để bài kiểm chứng minh «đổi chữ ⇒ đổi băm». */
export function hashLegalContent(document: LegalDocumentKey, version: string, effective: string, content: LegalDocumentContent): string {
  const payload = JSON.stringify({ document, version, effective, title: content.title, intro: canonicalLegalTree(content.intro), body: canonicalLegalTree(content.body) });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Băm nội dung của văn bản `document` ở phiên bản `version`. `null` khi: văn bản chưa công bố (DPA), hoặc `version` không
 * phải phiên bản đang công bố (nội dung phiên bản cũ không còn trong mã — không đoán). Hàm thuần: cùng mã ⇒ cùng kết quả.
 */
export function legalContentSha256(document: LegalDocumentKey, version: string): string | null {
  const doc = LEGAL_DOCUMENTS[document];
  if (doc.publication !== "PUBLISHED" || doc.version !== version) return null;
  return hashLegalContent(document, doc.version, doc.effective, doc.content);
}
