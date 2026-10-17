import { useRef } from "react";
import { MenuFlyout } from "../MenuFlyout";
import { SPEED_STEPS } from "./constants";
import { playerChromeBtn, playerMenuItem } from "./playerChrome";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  rate: number;
  onRateChange: (rate: number) => void;
}

/** Playback speed chip with preset buttons and a fine slider. */
export default function SpeedMenu({
  open,
  onToggle,
  onClose,
  rate,
  onRateChange,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
        className={`${playerChromeBtn(rate !== 1 || open)} tabular-nums`}
        title="Playback speed"
      >
        {rate}x
      </button>
      <MenuFlyout
        open={open}
        className="absolute bottom-9 right-0 z-10 w-40"
        menu={{
          kind: "popup",
          label: "Playback speed",
          onClose,
          triggerRef,
        }}
      >
        <div className="p-3">
          <div className="mb-2 grid grid-cols-3 gap-1">
            {SPEED_STEPS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => onRateChange(s)}
                aria-pressed={rate === s}
                className={`${playerMenuItem(rate === s)} tabular-nums`}
              >
                {s}x
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0.25}
            max={3}
            step={0.05}
            value={rate}
            onChange={(e) => onRateChange(Number(e.target.value))}
            aria-label="Playback speed"
            className="accent-scrubber w-full"
          />
        </div>
      </MenuFlyout>
    </div>
  );
}
