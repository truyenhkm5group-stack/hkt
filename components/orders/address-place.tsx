"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, MapPin } from "lucide-react";
import { checkAddressAction, type AddressCheck } from "@/lib/actions/address";

const SELECT = "h-8 w-full rounded-md border bg-background px-2 text-[12.5px]";

/** Hỏi máy chủ tỉnh + xã của dòng địa chỉ (chờ 400 ms sau lần gõ cuối). Dòng trống ⇒ `null`. */
export function useAddressCheck(address: string, province: string): AddressCheck | null {
  const [check, setCheck] = useState<AddressCheck | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!address.trim() && !province.trim()) {
        if (alive) setCheck(null);
        return;
      }
      void checkAddressAction(address, province).then((r) => {
        if (alive) setCheck(r);
      });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [address, province]);
  return check;
}

/**
 * Tỉnh + xã theo địa giới mới mà máy đọc được từ dòng địa chỉ — để đơn đẩy được sang hãng vận chuyển và tự xác nhận được.
 * Một đáp án ⇒ ✓ (bấm «đổi» để chọn khác); nhiều đáp án (xã cũ bị chia) / chỉ có tỉnh ⇒ ô chọn, gợi ý lên đầu; chưa nhận ra
 * tỉnh ⇒ nhắc ghi rõ tỉnh. `ward` = xã đang dùng (người chọn, không thì máy đọc).
 */
export function AddressPlace({ check, ward, onPick }: { check: AddressCheck | null; ward: string; onPick: (w: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!check) return null;
  if (!check.province) {
    return (
      <p className="flex items-center gap-1 text-[11.5px] text-amber-700 sm:col-span-2 dark:text-amber-300">
        <MapPin className="size-3.5" /> Chưa nhận ra tỉnh / thành — ghi rõ tỉnh để giao được.
      </p>
    );
  }
  if (!editing && ward) {
    return (
      <p className="flex items-center gap-1 text-[11.5px] text-emerald-700 sm:col-span-2 dark:text-emerald-300" data-testid="address-matched">
        <CheckCircle2 className="size-3.5" /> {ward} · {check.province}
        <button type="button" className="ml-1 text-muted-foreground underline underline-offset-2" onClick={() => setEditing(true)}>
          đổi
        </button>
      </p>
    );
  }
  const rest = check.wards.filter((w) => !check.candidates.includes(w));
  return (
    <label className="space-y-1 sm:col-span-2">
      <span className={`block text-[11.5px] ${ward ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}`}>{ward ? check.province : `${check.province} · ${check.reason || "chọn xã / phường"}`}</span>
      <select
        className={SELECT}
        value={ward}
        onChange={(e) => {
          onPick(e.target.value);
          setEditing(false);
        }}
        aria-label="Xã / phường"
      >
        <option value="">— Chọn xã / phường —</option>
        {check.candidates.length ? (
          <optgroup label="Gợi ý từ địa chỉ">
            {check.candidates.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </optgroup>
        ) : null}
        {ward && !check.wards.includes(ward) && !check.candidates.includes(ward) ? <option value={ward}>{ward}</option> : null}
        {rest.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
    </label>
  );
}
