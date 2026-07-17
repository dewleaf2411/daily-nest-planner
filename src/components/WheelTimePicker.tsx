import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Clock, Check, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface WheelTimePickerProps {
  /** 24h "HH:MM" */
  value: string;
  onChange: (next: string) => void;
  className?: string;
  ariaLabel?: string;
  id?: string;
}

const ITEM_H = 44;
const VISIBLE = 5;
const PAD = ((VISIBLE - 1) / 2) * ITEM_H;

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i); // 0..59
const PERIODS = ["AM", "PM"] as const;
type Period = (typeof PERIODS)[number];

function parse24(v: string): { h12: number; m: number; period: Period } {
  const [hStr = "0", mStr = "0"] = v.split(":");
  const H = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
  const M = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));
  const period: Period = H >= 12 ? "PM" : "AM";
  const h12 = ((H + 11) % 12) + 1;
  return { h12, m: M, period };
}

function to24(h12: number, m: number, period: Period): string {
  let H = h12 % 12;
  if (period === "PM") H += 12;
  return `${String(H).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function format12(v: string): string {
  const { h12, m, period } = parse24(v);
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function Column<T extends string | number>({
  items,
  value,
  onChange,
  renderItem,
}: {
  items: readonly T[];
  value: T;
  onChange: (v: T) => void;
  renderItem?: (v: T) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | null>(null);

  // Sync scroll position when value changes externally / on open.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const i = items.indexOf(value);
    if (i >= 0) el.scrollTop = i * ITEM_H;
  }, [value, items]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const idx = Math.round(el.scrollTop / ITEM_H);
      const clamped = Math.max(0, Math.min(items.length - 1, idx));
      const v = items[clamped];
      // Snap to exact position
      const target = clamped * ITEM_H;
      if (Math.abs(el.scrollTop - target) > 0.5) {
        el.scrollTo({ top: target, behavior: "smooth" });
      }
      if (v !== value) onChange(v);
    }, 90);
  };

  return (
    <div className="relative flex-1 h-[220px] overflow-hidden">
      <div
        ref={ref}
        onScroll={onScroll}
        className="h-full overflow-y-scroll snap-y snap-mandatory [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
      >
        <div style={{ height: PAD }} aria-hidden />
        {items.map((it) => {
          const selected = it === value;
          return (
            <button
              type="button"
              key={String(it)}
              onClick={() => onChange(it)}
              style={{ height: ITEM_H }}
              className={`w-full snap-center grid place-items-center text-lg font-medium tabular-nums transition-colors ${
                selected ? "text-primary" : "text-muted-foreground/50 hover:text-foreground"
              }`}
            >
              {renderItem ? renderItem(it) : String(it)}
            </button>
          );
        })}
        <div style={{ height: PAD }} aria-hidden />
      </div>
    </div>
  );
}

export function WheelTimePicker({ value, onChange, className, ariaLabel, id }: WheelTimePickerProps) {
  const [open, setOpen] = useState(false);
  const parsed = parse24(value);
  const [h12, setH12] = useState(parsed.h12);
  const [m, setM] = useState(parsed.m);
  const [period, setPeriod] = useState<Period>(parsed.period);

  useEffect(() => {
    if (open) {
      const p = parse24(value);
      setH12(p.h12);
      setM(p.m);
      setPeriod(p.period);
    }
  }, [open, value]);

  const done = () => {
    onChange(to24(h12, m, period));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={ariaLabel}
          className={`w-full inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground text-left outline-none focus:ring-2 focus:ring-primary/30 hover:bg-secondary/40 transition ${
            className ?? ""
          }`}
        >
          <Clock className="h-4 w-4 text-muted-foreground" strokeWidth={1.6} />
          <span className="tabular-nums">{format12(value)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="pointer-events-auto w-[320px] rounded-2xl border border-border bg-card p-3 shadow-lg"
      >
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="inline-flex items-center gap-2 text-sm text-foreground">
            <Clock className="h-4 w-4 text-primary" strokeWidth={1.6} />
            Select time
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative rounded-2xl bg-secondary/40 p-2">
          {/* Selected row pill */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2 h-11 rounded-xl bg-primary/20"
          />
          {/* Soft fade top/bottom */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-10 rounded-t-2xl bg-gradient-to-b from-card to-transparent"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-2xl bg-gradient-to-t from-card to-transparent"
          />
          <div className="relative flex items-stretch">
            <Column items={HOURS} value={h12} onChange={setH12} />
            <Column
              items={MINUTES}
              value={m}
              onChange={setM}
              renderItem={(v) => String(v).padStart(2, "0")}
            />
            <Column items={PERIODS} value={period} onChange={setPeriod} />
          </div>
        </div>

        <button
          type="button"
          onClick={done}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition"
        >
          <Check className="h-4 w-4" /> Done
        </button>
      </PopoverContent>
    </Popover>
  );
}
