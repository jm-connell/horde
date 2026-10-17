import { useRef } from "react";
import { MenuFlyout } from "../MenuFlyout";
import { qualityMenuLabel, type QualityChoice } from "../videoPlayerQuality";
import { playerChromeBtn, playerMenuItem } from "./playerChrome";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The viewer's pick, or "auto". */
  choice: QualityChoice;
  /** Quality of the track playing now, when known. */
  activeQuality: number | null;
  /** Distinct short-side qualities offered by the stream. */
  heights: number[];
  onPick: (choice: QualityChoice) => void;
}

/** Stream quality chip and its radio menu (adaptive streams only). */
export default function QualityMenu({
  open,
  onToggle,
  onClose,
  choice,
  activeQuality,
  heights,
  onPick,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
        className={`${playerChromeBtn(choice !== "auto" || open)} tabular-nums`}
        title="Stream quality"
      >
        {choice === "auto" && activeQuality
          ? `Auto · ${qualityMenuLabel(activeQuality)}`
          : qualityMenuLabel(choice)}
      </button>
      <MenuFlyout
        open={open}
        className="absolute bottom-9 right-0 z-10 w-32"
        menu={{
          label: "Stream quality",
          onClose,
          triggerRef,
        }}
      >
        <div className="flex flex-col">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={choice === "auto"}
            onClick={() => {
              onPick("auto");
              onClose();
            }}
            className={`${playerMenuItem(choice === "auto")} text-left`}
          >
            Auto
            {activeQuality && choice === "auto"
              ? ` · ${qualityMenuLabel(activeQuality)}`
              : ""}
          </button>
          {heights.map((h) => (
            <button
              key={h}
              type="button"
              role="menuitemradio"
              aria-checked={choice === h}
              onClick={() => {
                onPick(h);
                onClose();
              }}
              className={`${playerMenuItem(choice === h)} text-left tabular-nums`}
            >
              {qualityMenuLabel(h)}
            </button>
          ))}
        </div>
      </MenuFlyout>
    </div>
  );
}
