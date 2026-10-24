import { useState } from "react";
import { PANEL_BTN } from "../../pages/settings/constants";
import {
  recoveryCodesFileName,
  recoveryCodesText,
} from "../../utils/twoFactor";

/**
 * The recovery codes, shown once: copy them or save a .txt. The server keeps
 * only a hash of each, so this is the only time they can be read.
 */
export default function RecoveryCodes({
  username,
  codes,
}: {
  username: string;
  codes: string[];
}) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied("yes");
    } catch {
      // Plain-http pages have no clipboard API: the codes are selectable.
      setCopied("failed");
    }
  };

  const download = () => {
    const blob = new Blob([recoveryCodesText(username, codes)], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = recoveryCodesFileName(username);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-horde="recovery-codes">
      <p className="mb-3 text-sm text-gray-300">
        Keep these somewhere safe. Each works once if you lose your
        authenticator. They are shown only now.
      </p>
      <ul
        aria-label="Recovery codes"
        className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-sm text-gray-100 select-all"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={PANEL_BTN} onClick={() => void copy()}>
          Copy codes
        </button>
        <button type="button" className={PANEL_BTN} onClick={download}>
          Download .txt
        </button>
        <span role="status" className="text-xs text-muted">
          {copied === "yes"
            ? "Copied."
            : copied === "failed"
              ? "Could not copy. Select the codes and copy them by hand."
              : ""}
        </span>
      </div>
    </div>
  );
}
