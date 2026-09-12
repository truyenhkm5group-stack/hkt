import { AlertTriangle, Building2 } from "lucide-react";
import { WorkList } from "@/components/work/work-list";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { MY_WORK_BUCKET_HINT, MY_WORK_BUCKET_LABEL } from "@/lib/constants/work";
import { formatVND } from "@/lib/format";
import { departmentsOfUser, getMyWork } from "@/lib/queries/work";

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
  const [my, phongCuaToi] = await Promise.all([
    getMyWork({ id: user.id, name: user.name, email: user.email }),
    departmentsOfUser(user.id),
  ]);
  const canAct = can(user, "work:manage");
  const upcoming = my.groups.find((g) => g.bucket === "UPCOMING");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title={`Việc của ${user.name}`}
        description={my.total ? `${my.total} việc đang cầm · ${my.overdue} việc quá hạn` : "Không còn việc nào được giao cho bạn."}
        hint="Việc ở đây gom từ mọi hàng đợi của ERP: case CSKH, care vận đơn, kiểm đếm hàng hoàn, dòng tiền chưa phân loại, quyết định quảng cáo, cảnh báo vận hành, và việc quản lý giao tay. Trạng thái nghiệp vụ vẫn thuộc về module gốc — bấm nút ở đây là gọi đúng hành động của module đó, không phải đánh dấu xong."
      />

      {/*
        CHƯA CÓ PHÒNG BAN THÌ HÀNG ĐỢI TRỐNG — VÀ PHẢI NÓI RÕ VÌ SAO.

        Phòng ban quyết định người này thấy việc nào. Người chưa được xếp phòng mở trang lên chỉ
        thấy một danh sách rỗng, và một danh sách rỗng trông hệt như "hôm nay hết việc". Đo trên
        production trước bản này: 1 trong 2 tài khoản đang ở đúng tình trạng đó.
      */}
      {phongCuaToi.length === 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Building2 className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Bạn chưa được xếp vào phòng ban nào</p>
            <p className="text-xs">
              Việc của các phòng sẽ không tới tay bạn cho tới khi quản trị viên xếp phòng ở <strong>Công việc → Cấu hình → Nhân sự và phòng ban</strong>.
              Danh sách trống bên dưới KHÔNG có nghĩa là hôm nay hết việc.
            </p>
          </div>
        </div>
      ) : null}

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

      {/*
        NĂM RỔ MỞ SẴN, RỔ THỨ SÁU GẤP LẠI.

        "Sắp tới" là việc hạn còn xa — theo định nghĩa nó KHÔNG phải việc của hôm nay. Mở sẵn nó
        thì nó đẩy năm rổ thật xuống dưới nếp gấp và cạnh tranh sự chú ý với việc quá hạn. Gấp lại
        chứ không giấu: số việc vẫn in ở nhãn, một cú bấm là thấy.
      */}
      {my.groups
        .filter((g) => g.count > 0 && g.bucket !== "UPCOMING")
        .map((g) => (
          <SectionCard
            key={g.bucket}
            title={`${MY_WORK_BUCKET_LABEL[g.bucket]} · ${g.count}`}
            description={MY_WORK_BUCKET_HINT[g.bucket]}
            padded={false}
          >
            <WorkList items={g.items} compact showDepartment emptyTitle="Không có việc nào" canAct={canAct} />
          </SectionCard>
        ))}

      {upcoming && upcoming.count > 0 ? (
        <details className="rounded-xl border bg-card">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">
            {MY_WORK_BUCKET_LABEL.UPCOMING} · {upcoming.count}
            <span className="ml-2 text-xs font-normal text-muted-foreground">{MY_WORK_BUCKET_HINT.UPCOMING} — bấm để mở</span>
          </summary>
          <div className="border-t">
            <WorkList items={upcoming.items} compact showDepartment emptyTitle="Không có việc nào" canAct={canAct} />
          </div>
        </details>
      ) : null}

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
