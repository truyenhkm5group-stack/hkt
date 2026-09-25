"use client";

import { useState, useTransition } from "react";
import { ArrowRightLeft, Building2, Crown, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { LeavingImpactDialog, type LeavingImpactView } from "@/components/leaving-impact-dialog";
import { PickerMenu } from "@/components/picker-menu";
import { assignUserToDepartment, leavingImpact, removeUserFromDepartment, setLead, transferUserDepartment } from "@/lib/actions/org";
import { cn } from "@/lib/utils";

/**
 * ═══════════ PHÒNG BAN NGAY TRÊN HỒ SƠ NGƯỜI DÙNG ═══════════
 *
 * Trước bản này, "gán phòng ban cho một người" chỉ làm được từ MỘT phía — màn Cấu hình công việc.
 * Khi ô chọn ở phía đó hỏng (xem `components/picker-menu.tsx`), không còn lối nào khác, và người
 * quản trị tài khoản không có cách nào tự xoay xở.
 *
 * Nay hai màn hình gọi CÙNG một bộ Server Action (`lib/actions/org.ts` → `lib/org/membership.ts`),
 * nên chúng không thể nói hai sự thật khác nhau và không thể sinh ra dòng trùng.
 *
 * ─── RỜI PHÒNG KHI ĐANG CẦM VIỆC PHẢI HỎI LẠI ───
 *
 * Bỏ một người khỏi phòng KHÔNG tự giao lại việc của họ — đó là luật, và nó đúng: người chuyển
 * phòng vẫn phải đóng nốt việc dở. Nhưng người bấm cần BIẾT điều đó trước, nên ở đây mở hộp thoại
 * xem trước tác động (việc đang cầm, quá hạn, tiền treo, ở phòng nào) rồi mới xác nhận. Tự rải
 * lại vài chục việc vì một cú bấm là thứ không gỡ lại được.
 */

export type UserDept = { departmentId: string; code: string; name: string; roleInDept: "LEAD" | "MEMBER"; isLead: boolean };

export function DepartmentCell({
  userId,
  userName,
  userActive,
  departments,
  all,
}: {
  userId: string;
  userName: string;
  userActive: boolean;
  departments: UserDept[];
  all: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: true } | { error: string } | { ok: true; changed: boolean } | { ok: true; leadCleared: boolean }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(ok);
    });

  /*
    Mở hộp thoại TRƯỚC, đếm việc SAU. Nếu đợi đếm xong mới mở thì người bấm thấy giao diện đứng im
    vài trăm mili-giây và bấm lại — còn hộp thoại mở ngay thì họ thấy "đang đếm" và biết hệ thống
    đã nhận lệnh.
  */
  const [xacNhan, setXacNhan] = useState<{ kind: "REMOVE"; dept: UserDept } | { kind: "TRANSFER"; from: UserDept; toId: string; toName: string } | null>(null);
  const [tacDong, setTacDong] = useState<LeavingImpactView | null>(null);

  const hoiTruoc = (yeuCau: NonNullable<typeof xacNhan>) => {
    setTacDong(null);
    setXacNhan(yeuCau);
    void leavingImpact(userId).then((r) => {
      if (!("error" in r)) setTacDong(r.impact);
    });
  };

  const dongY = () => {
    const yc = xacNhan;
    if (!yc) return;
    start(async () => {
      const r =
        yc.kind === "REMOVE"
          ? await removeUserFromDepartment({ departmentId: yc.dept.departmentId, userId })
          : await transferUserDepartment({ fromDepartmentId: yc.from.departmentId, toDepartmentId: yc.toId, userId });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      if (yc.kind === "REMOVE") {
        toast.success("leadCleared" in r && r.leadCleared ? `Đã bỏ khỏi ${yc.dept.name} — ghế trưởng phòng cũng trống` : `Đã bỏ khỏi ${yc.dept.name}`);
      } else {
        toast.success(`Đã chuyển ${userName} sang ${yc.toName}`);
      }
      setXacNhan(null);
    });
  };

  const conLai = all.filter((a) => !departments.some((d) => d.departmentId === a.id));

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {departments.map((d) => (
        <Badge key={d.departmentId} variant="secondary" className="gap-1 pr-1 text-[11px]">
          {d.name}
          {d.isLead ? <Crown className="size-3 text-amber-600" aria-label="Trưởng phòng" /> : null}
          <button
            type="button"
            aria-label={`Đặt ${userName} làm trưởng ${d.name}`}
            title={d.isLead ? "Đang là trưởng phòng" : "Đặt làm trưởng phòng"}
            disabled={pending || d.isLead}
            className="rounded p-0.5 hover:bg-background disabled:opacity-40"
            onClick={() => run(() => setLead({ departmentId: d.departmentId, userId }), `Đã đặt ${userName} làm trưởng ${d.name}`)}
          >
            <Crown className={cn("size-3", d.isLead && "text-amber-600")} />
          </button>
          <button type="button" aria-label={`Bỏ ${userName} khỏi ${d.name}`} title="Bỏ khỏi phòng (giữ lịch sử)" disabled={pending} className="rounded p-0.5 hover:bg-background" onClick={() => hoiTruoc({ kind: "REMOVE", dept: d })}>
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {departments.length === 0 ? <span className="text-[11px] text-muted-foreground">chưa có phòng ban</span> : null}
      <PickerMenu
        className="h-6 px-1.5 text-[11px]"
        label="Thêm"
        icon={<Building2 className="size-3" />}
        align="start"
        disabled={pending || !userActive}
        empty={userActive ? "Đã ở mọi phòng đang dùng" : "Tài khoản đã khoá"}
        options={conLai.map((a) => ({ value: a.id, label: a.name }))}
        onPick={(v) => run(() => assignUserToDepartment({ departmentId: v, userId }), "Đã thêm vào phòng")}
      />
      {/*
        CHUYỂN PHÒNG là một thao tác riêng, không phải "thêm rồi bỏ".

        Ghép hai lệnh ở giao diện thì có một khoảnh khắc người đó không thuộc phòng nào, và nếu
        lệnh thứ hai hỏng thì họ mắc kẹt ở đó. Nút này chỉ hiện khi người đó ở ĐÚNG MỘT phòng —
        ở nhiều phòng thì "chuyển từ đâu" là câu hỏi không có câu trả lời hiển nhiên, và đoán hộ
        là cách nhanh nhất để bỏ nhầm người khỏi phòng họ cần ở lại.
      */}
      {departments.length === 1 && conLai.length ? (
        <PickerMenu
          className="h-6 px-1.5 text-[11px]"
          label="Chuyển"
          icon={<ArrowRightLeft className="size-3" />}
          align="start"
          disabled={pending || !userActive}
          empty="Không còn phòng nào khác"
          options={conLai.map((a) => ({ value: a.id, label: `${departments[0].name} → ${a.name}` }))}
          onPick={(v) => hoiTruoc({ kind: "TRANSFER", from: departments[0], toId: v, toName: conLai.find((a) => a.id === v)?.name ?? "phòng mới" })}
        />
      ) : null}

      {xacNhan ? (
        <LeavingImpactDialog
          open
          onOpenChange={(v) => (v ? null : setXacNhan(null))}
          userName={userName}
          title={xacNhan.kind === "REMOVE" ? `Bỏ ${userName} khỏi ${xacNhan.dept.name}?` : `Chuyển ${userName} sang ${xacNhan.toName}?`}
          description={
            xacNhan.kind === "REMOVE"
              ? "Dòng thành viên được giữ lại (đánh dấu đã rời), nên lịch sử và việc đã giao không mất."
              : "Thêm vào phòng mới trước, rời phòng cũ sau — không có khoảnh khắc nào họ không thuộc phòng nào."
          }
          confirmLabel={xacNhan.kind === "REMOVE" ? "Bỏ khỏi phòng" : "Chuyển phòng"}
          impact={tacDong}
          pending={pending}
          onConfirm={dongY}
        />
      ) : null}
    </div>
  );
}
