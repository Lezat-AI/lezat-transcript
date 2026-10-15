import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import { dayMonthYearToIso, isoToDayMonthYear } from "@/utils/dayMonthYear";

/**
 * Date field written and shown as dd/mm/aaaa. The native date input follows
 * the computer's region (mm/dd/yyyy on a US Mac), so it only backs the
 * calendar button. ``value``/``onChange`` use "YYYY-MM-DD" ("" when empty).
 */
export function DayMonthYearInput({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(isoToDayMonthYear(value));
  const [invalid, setInvalid] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  // Follow changes made outside (calendar button, reset of the form); the
  // text being typed is not a dependency, or each keystroke would reformat it.
  useEffect(() => {
    if (dayMonthYearToIso(text) !== value) {
      setText(isoToDayMonthYear(value));
      setInvalid(false);
    }
  }, [value]);

  const commit = (next: string) => {
    setText(next);
    const iso = dayMonthYearToIso(next);
    setInvalid(iso === null);
    if (iso !== null && iso !== value) onChange(iso);
  };

  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker || disabled) return;
    try {
      picker.showPicker();
    } catch {
      picker.focus();
    }
  };

  return (
    <div className="relative flex items-center">
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={t("common.dateFormatPlaceholder")}
        onChange={(e) => commit(e.target.value)}
        disabled={disabled}
        aria-invalid={invalid}
        className={`${className ?? ""} w-full pr-8 ${invalid ? "border-red-500/60" : ""}`}
      />
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-label={t("common.pickDate")}
        className="absolute right-2 text-mid-gray hover:text-text disabled:opacity-50"
      >
        <CalendarDays className="w-4 h-4" />
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute right-0 bottom-0 w-0 h-0 opacity-0 pointer-events-none"
      />
    </div>
  );
}
