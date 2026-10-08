"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { assignModelCode, declareModelsFromSuggestion, setModelOwner, transitionModel } from "@/lib/actions/models";
import { BULK_DECLARE_DEFAULT_REASON, DECLARE_ROW_OUTCOME_LABEL } from "@/lib/constants/model-bulk-declare";
import { checkModelTransition, MODEL_REASON_MIN_LENGTH, MODEL_STATE_LABELS, MODEL_STATES, MODEL_TRANSITIONS, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";
import type { WinnerFollowUp } from "@/lib/constants/early-topic";
import { staleUpdateReason, type StaleStateSuggestion } from "@/lib/constants/model-stale-state";

/**
 * ĐỔI TRẠNG THÁI KHAI. Hiện cả khi mẫu CHƯA KHAI (`state = null`) — đó chính là lúc người cần khai.
 *
 * Cạnh "tiến" trong bảng đứng đầu danh sách; mọi trạng thái khác vẫn chọn được nhưng ô lý do bật lên và
 * bắt buộc (cùng `checkModelTransition` mà máy chủ dùng để chặn thật).
 *
 * `winnerFollowUp` (Agent T): sản xuất của mẫu đã đi trước (topic mở sớm, giá thành, mẫu thử…). Người vừa
 * khai THẮNG thì hiện NGAY một nút chuyển tiếp tới đúng chỗ sản xuất đang đứng, lý do điền sẵn — một cú
 * bấm, vẫn đi qua `transitionModel`. Không bấm thì không có gì đổi.
 *
 * `suggested` (Agent Q): mẫu CHƯA KHAI mà máy có gợi ý giai đoạn (ƯỚC TÍNH) ⇒ chọn sẵn gợi ý và điền sẵn lý
 * do — bản MỘT MẪU của "Khai theo gợi ý": lưu đi qua `declareModelsFromSuggestion` (hàng rào "vẫn chưa
 * khai", lịch sử ghi gợi ý + người có chọn khác không). Vẫn chỉ ghi khi người bấm "Lưu trạng thái".
 *
 * `stale` (Agent ST): mẫu ĐÃ KHAI mà chứng từ đã đi trước lời khai (thiết kế đã lên camp / có phán quyết, sản
 * xuất đã đi tiếp) ⇒ hiện câu chứng cứ, chọn sẵn đích và điền sẵn lý do (sửa được). Lưu đi CÙNG lõi của Q với
 * hàng rào `expectedState` = lời khai đang hiện — người khác vừa đổi thì bỏ qua, không đè.
 */
export function TransitionControl({
  modelId,
  state,
  winnerFollowUp = null,
  suggested = null,
  stale = null,
}: {
  modelId: string;
  state: ModelState | null;
  winnerFollowUp?: WinnerFollowUp | null;
  suggested?: ModelState | null;
  stale?: StaleStateSuggestion | null;
}) {
  const tien = state ? MODEL_TRANSITIONS[state] : [];
  const conLai = MODEL_STATES.filter((s) => s !== state && !tien.includes(s));
  const theoGoiY = state === null && suggested !== null;
  const theoThucTe = state !== null && stale !== null;
  const [to, setTo] = useState<ModelState | "">(theoGoiY ? suggested : theoThucTe && stale ? stale.to : (tien[0] ?? ""));
  const [reason, setReason] = useState(theoGoiY ? BULK_DECLARE_DEFAULT_REASON : theoThucTe && stale ? staleUpdateReason(stale) : "");
  const [followUp, setFollowUp] = useState<WinnerFollowUp | null>(null);
  const [pending, start] = useTransition();

  const kiem = to ? checkModelTransition(state, to) : null;
  // Luồng cập nhật theo thực tế luôn ghi lý do (lõi của Q đòi) — ô lý do hiện sẵn, đã điền.
  const canLyDo = !!kiem && kiem.ok && (kiem.needsReason || theoThucTe);
  const duoc = !!kiem && kiem.ok && (!canLyDo || reasonIsEnough(reason));

  const luu = () =>
    start(async () => {
      if (!to) return;
      if (theoThucTe && state !== null) {
        const k = await declareModelsFromSuggestion({ items: [{ modelId, state: to, expectedState: state }], reason, from: "detail", kind: "stale" });
        if ("error" in k) {
          toast.error(k.error);
          return;
        }
        const dong = k.results[0];
        if (!dong || dong.outcome !== "DECLARED") {
          toast.error(dong ? `${DECLARE_ROW_OUTCOME_LABEL[dong.outcome]}${dong.current ? ` (hiện: ${MODEL_STATE_LABELS[dong.current]})` : ""}${dong.error ? `: ${dong.error}` : ""}` : "Không cập nhật được");
          return;
        }
        toast.success(`Đã cập nhật: ${MODEL_STATE_LABELS[to]}${to === stale?.to ? " (theo thực tế)" : ""}`);
        // Trang dựng lại với lời khai mới; ô chọn cũ (đích vừa lưu) không còn là một lượt chuyển hợp lệ.
        setTo("");
        setReason("");
        setFollowUp(to === "WINNER" ? winnerFollowUp : null);
        return;
      }
      if (theoGoiY) {
        const k = await declareModelsFromSuggestion({ items: [{ modelId, state: to, expectedState: null }], reason, from: "detail" });
        if ("error" in k) {
          toast.error(k.error);
          return;
        }
        const dong = k.results[0];
        if (!dong || dong.outcome !== "DECLARED") {
          toast.error(dong ? `${DECLARE_ROW_OUTCOME_LABEL[dong.outcome]}${dong.error ? `: ${dong.error}` : ""}` : "Không khai được");
          return;
        }
        toast.success(`Đã khai: ${MODEL_STATE_LABELS[to]}${to === suggested ? " (theo gợi ý)" : ""}`);
        setFollowUp(to === "WINNER" ? winnerFollowUp : null);
        return;
      }
      const r = await transitionModel({ modelId, to, reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã khai: ${MODEL_STATE_LABELS[to]}`);
      setReason("");
      // Giữ đề xuất ở trạng thái cục bộ: sau khi trang dựng lại, nó không còn được truyền xuống (mẫu đã ở THẮNG).
      setFollowUp(to === "WINNER" ? winnerFollowUp : null);
    });

  const chuyenTiep = () =>
    start(async () => {
      if (!followUp) return;
      const r = await transitionModel({ modelId, to: followUp.to, reason: followUp.reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã khai: ${MODEL_STATE_LABELS[followUp.to]}`);
      setFollowUp(null);
    });

  return (
    <div className="space-y-2">
      {theoThucTe && stale && state ? (
        <div className="space-y-1 rounded-lg border border-sky-300/60 bg-sky-50 p-2.5 text-xs dark:border-sky-800 dark:bg-sky-950/30" data-testid="stale-state-note">
          <p className="font-semibold">
            Thực tế đã đi trước lời khai &ldquo;{MODEL_STATE_LABELS[state]}&rdquo; — đề xuất cập nhật sang &ldquo;{MODEL_STATE_LABELS[stale.to]}&rdquo;
          </p>
          <p className="text-muted-foreground">{stale.reasons.join(" · ")}</p>
          <p className="text-muted-foreground">Đã chọn sẵn bên dưới, lý do điền sẵn (sửa được). Máy không tự ghi — bấm &ldquo;Lưu trạng thái&rdquo; để cập nhật.</p>
        </div>
      ) : null}
      {followUp ? (
        <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs">
          <p className="font-semibold">Sản xuất của mẫu đã đi trước lúc thắng — chuyển tiếp vòng đời?</p>
          <p className="text-muted-foreground">{followUp.reason}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="h-7" disabled={pending} onClick={chuyenTiep}>
              {pending ? "Đang lưu…" : `Chuyển tiếp sang “${MODEL_STATE_LABELS[followUp.to]}”`}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={pending} onClick={() => setFollowUp(null)}>
              Để sau
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px]">
          <Label className="text-xs">{state ? "Chuyển sang" : "Khai trạng thái đầu tiên"}</Label>
          <Select value={to} onValueChange={(v) => setTo(v as ModelState)}>
            <SelectTrigger aria-label={state ? "Chuyển mẫu sang trạng thái" : "Trạng thái đầu tiên của mẫu"} className="h-8">
              <SelectValue placeholder="Chọn trạng thái" />
            </SelectTrigger>
            <SelectContent>
              {tien.map((s) => (
                <SelectItem key={s} value={s}>
                  {MODEL_STATE_LABELS[s]} · bước tiếp
                  {theoThucTe && s === stale?.to ? " · theo thực tế" : ""}
                </SelectItem>
              ))}
              {conLai.map((s) => (
                <SelectItem key={s} value={s}>
                  {MODEL_STATE_LABELS[s]}
                  {state ? " · cần lý do" : ""}
                  {theoGoiY && s === suggested ? " · máy gợi ý (ước tính)" : ""}
                  {theoThucTe && s === stale?.to ? " · theo thực tế" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" className="h-8" disabled={pending || !duoc} onClick={luu}>
          {pending ? "Đang lưu…" : "Lưu trạng thái"}
        </Button>
      </div>
      {canLyDo ? (
        <div className="space-y-1">
          <Label className="text-xs">
            Lý do (bắt buộc, ít nhất {MODEL_REASON_MIN_LENGTH} ký tự) — {theoThucTe ? "cập nhật theo thực tế, ghi vào lịch sử" : state ? "đây là lùi bước hoặc nhảy cóc" : "đây là lần khai đầu tiên của mẫu"}
          </Label>
          <Textarea aria-label="Lý do đổi trạng thái" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vì sao mẫu đang ở trạng thái này…" />
        </div>
      ) : null}
    </div>
  );
}

const KHONG_AI = "__none__";

/** Người phụ trách — do NGƯỜI chọn trong danh sách tài khoản đang hoạt động. */
export function OwnerControl({ modelId, ownerUserId, options }: { modelId: string; ownerUserId: string | null; options: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  return (
    <Select
      value={ownerUserId ?? KHONG_AI}
      disabled={pending}
      onValueChange={(v) =>
        start(async () => {
          const r = await setModelOwner({ modelId, ownerUserId: v === KHONG_AI ? null : v });
          if ("error" in r) {
            toast.error(r.error);
            return;
          }
          toast.success("Đã đổi người phụ trách");
        })
      }
    >
      <SelectTrigger aria-label="Người phụ trách mẫu" className="h-8 min-w-[200px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={KHONG_AI}>— Chưa có người phụ trách</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * CHỐT MÃ CHÍNH THỨC cho mẫu đang mang mã tạm (`TEST-…` — mẫu mới test mở topic sản xuất trước khi lên
 * mã, chủ shop 26/09/2026). Chỉ đổi MÃ của đúng dòng này; khai THẮNG vẫn ở ô trạng thái bên trên.
 */
export function AssignCodeControl({ modelId, code }: { modelId: string; code: string }) {
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const luu = () =>
    start(async () => {
      const r = await assignModelCode({ modelId, code: value });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã chốt mã ${r.code}`);
      setValue("");
    });
  return (
    <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-xs text-amber-900 dark:text-amber-200">
        Mẫu đang mang <b>mã tạm</b> <span className="font-mono">{code}</span>. Mẫu thắng thì chốt mã chính thức — topic, giá thành, mẫu thử, ảnh/video đã gắn đi theo nguyên vẹn; lần đồng bộ sổ sau tự nối sản phẩm Pancake mang mã mới.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="assign-code" className="text-xs">
          Mã chính thức
        </Label>
        <Input id="assign-code" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Q012" className="h-8 w-40 font-mono" />
        <Button size="sm" onClick={luu} disabled={pending || !value.trim()}>
          Chốt mã chính thức
        </Button>
      </div>
    </div>
  );
}
