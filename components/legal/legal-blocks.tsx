import * as React from "react";
import type { ReactNode } from "react";
import { COMPANY } from "@/lib/constants/company";

/**
 * KHỐI NỘI DUNG của văn bản pháp lý công khai — tách khỏi `legal-page.tsx` (khung trang, đọc host) để nội dung văn bản
 * (`terms-content.tsx`, `privacy-content.tsx`) dựng được ở mọi nơi KHÔNG có yêu cầu HTTP: trang, và hàm băm nội dung của
 * sổ văn bản (`lib/constants/legal-documents.ts::legalContentSha256`). Ba khối dưới đây là hàm / phần tử THUẦN, đồng bộ,
 * không đọc gì ngoài props — hàm băm mở chúng ra như React mở, nên chúng phải giữ tính chất đó.
 * `import * as React`: `tsx` (bài kiểm) dựng JSX theo runtime cổ điển, cần `React` trong phạm vi khi tệp được nạp.
 */

/** Nội dung một văn bản: tiêu đề + đoạn mở đầu + thân. Khung trang (đầu / chân / thương hiệu theo host) KHÔNG thuộc nội dung. */
export type LegalDocumentContent = { title: string; intro: ReactNode; body: ReactNode };

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-[15px] leading-7 text-foreground/90">{children}</div>
    </section>
  );
}

export function LegalTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const supportMail = (
  <a href={`mailto:${COMPANY.email}`} className="font-medium text-primary underline">
    {COMPANY.email}
  </a>
);
