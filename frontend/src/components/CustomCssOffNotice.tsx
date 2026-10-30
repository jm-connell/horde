import { useState } from "react";
import { Link } from "react-router-dom";
import {
  applyCustomCss,
  customCssSuspended,
  resumeCustomCss,
} from "../customCss";
import { loadSettings } from "../hooks/useSettings";
import { button } from "./buttons";

/**
 * Shown while `?nocss` has custom CSS switched off in this tab, so it is
 * clear why the page looks plain and how to fix or restore the stylesheet.
 */
export default function CustomCssOffNotice() {
  const [off, setOff] = useState(customCssSuspended);
  if (!off) return null;
  return (
    <div
      role="status"
      data-horde="custom-css-off"
      className="ui-panel mx-auto mb-4 flex max-w-2xl flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-900 px-4 py-3 text-sm text-gray-300 ring-1 ring-warning/40"
    >
      <p>
        Custom CSS is off in this tab (you opened Horde with{" "}
        <code className="font-mono text-gray-200">?nocss</code>).
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/settings?tab=appearance&find=custom-css"
          className={button("secondary", "sm")}
        >
          Edit custom CSS
        </Link>
        <button
          type="button"
          className={button("secondary", "sm")}
          onClick={() => {
            resumeCustomCss();
            const s = loadSettings();
            applyCustomCss(s.customCss, s.customCssEnabled);
            setOff(false);
          }}
        >
          Turn it back on
        </button>
      </div>
    </div>
  );
}
