import { useRef, useState } from "react";
import { MenuFlyout } from "../../components/MenuFlyout";
import { MoreIcon } from "../../components/icons";
import { button } from "../../components/buttons";

/** The ••• row under a live or past stream (as under a library video). */
export default function StreamActions({
  onSaveClip,
}: {
  onSaveClip: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="mt-5 flex">
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          aria-label="More stream actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={button("secondary")}
        >
          <MoreIcon />
        </button>
        <MenuFlyout
          open={open}
          className="absolute bottom-full left-0 z-30 mb-1 min-w-44"
          menu={{
            label: "Stream actions",
            onClose: () => setOpen(false),
            triggerRef,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSaveClip();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-ink-800"
          >
            Save a clip…
          </button>
        </MenuFlyout>
      </div>
    </div>
  );
}
