import { AlertTriangle } from "lucide-react";
import { WorkList } from "@/components/work/work-list";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { MY_WORK_BUCKET_HINT, MY_WORK_BUCKET_LABEL } from "@/lib/constants/work";
import { formatVND } from "@/lib/format";
import { getMyWork } from "@/lib/queries/work";

export const metadata = { title: "Việc của tôi" };

/**
 * ═══════ VIỆC CỦA TÔI — MÀN HÌNH MẶC ĐỊNH CỦA MỘT NGÀY LÀM VIỆC ═══════
 *
 * Sáu rổ, xếp theo THỨ TỰ PHẢI LÀM chứ không theo bảng chữ cái, và **không hiện việc đã xong**:
 * người mở trang lên để biết làm gì tiếp, không phải để ngắm thành tích.
 *
 * Việc ở đây đến từ SÁU hàng đợi khác nhau của ERP (CSKH, care vận đơn, kho, tài chính, quảng
 * cáo, cảnh báo) cộng việc giao tay — nhưng người dùng không cần biết điều đó. Họ thấy một danh
 * sách, và mỗi dòng làm được việc ngay tại chỗ.
 */
export default async function MyWorkPage() {
  const user = await requirePermission("work:view");
  const my = await getMyWork({ id: user.id, name: user.name, email: user.email });
  const canAct = can(user, "work:manage");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title={`Việc của ${user.name}`}
        description={my.total ? `${my.total} việc đang cầm · ${my.overdue} việc quá hạn` : "Không còn việc nào được giao cho bạn."}
        hint="Việc ở đây gom từ mọi hàng đợi của ERP: case CSKH, care vận đơn, kiểm đếm hàng hoàn, dòng tiền chưa phân loại, quyết định quảng cáo, cảnh báo vận hành, và việc quản lý giao tay. Trạng thái nghiệp vụ vẫn thuộc về module gốc — bấm nút ở đây là gọi đúng hành động của module đó, không phải đánh dấu xong."
      />

      {my.failedSources.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Danh sách đang thiếu một phần</p>
            {/* Một hàng đợi ngắn hơn thực tế mà không nói gì còn tệ hơn một lỗi hiện rõ. */}
            <p className="text-xs">Chưa đọc được: {my.failedSources.map((f) => f.source).join(", ")}. Việc thuộc các nguồn này chưa hiện ở đây.</p>
          </div>
        </div>
      ) : null}

      <StatStrip
        columns={4}
        items={[
          { label: "Quá hạn", value: my.overdue, tone: my.overdue ? "rose" : "muted", note: "làm trước hết" },
          { label: "Đang cầm", value: my.total, note: "mọi nguồn cộng lại" },
          {
            label: "Tiền đang treo",
            value: my.money.known ? formatVND(my.money.atRisk, { compact: true }) : "—",
            note: my.money.unknown ? `${my.money.unknown} việc chưa tra được tiền` : "đã tra được hết",
            hint: "Tổng chỉ cộng những việc TRA ĐƯỢC số tiền. Việc chưa tra được không được coi là 0đ — số việc đó hiện ngay cạnh để bạn biết tổng này đứng trên bao nhiêu phần.",
          },
          { label: "Có thể thu lại", value: my.money.recoverable ? formatVND(my.money.recoverable, { compact: true }) : "—", note: "nếu xử lý kịp" },
        ]}
      />

      {my.groups
        .filter((g) => g.count > 0)
        .map((g) => (
          <SectionCard
            key={g.bucket}
            title={`${MY_WORK_BUCKET_LABEL[g.bucket]} · ${g.count}`}
            description={MY_WORK_BUCKET_HINT[g.bucket]}
            padded={false}
          >
            <WorkList items={g.items} showDepartment emptyTitle="Không có việc nào" canAct={canAct} />
          </SectionCard>
        ))}

      {my.total === 0 ? (
        <SectionCard title="Hàng đợi trống">
          <p className="text-sm text-muted-foreground">
            Không việc nào đang mang tên bạn. Việc chưa ai nhận nằm ở tab <strong>Phòng ban</strong> — mở lên và bấm &ldquo;Nhận việc&rdquo; để kéo về đây.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}
