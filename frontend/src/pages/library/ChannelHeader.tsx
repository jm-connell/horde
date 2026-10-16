import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { focusOnMount } from "../../utils";

/**
 * The page title. On a channel page it carries a pencil to rename the channel
 * in place (for accounts that may edit metadata).
 */
export default function ChannelHeader({
  headline,
  activeChannel,
  isHome,
  onRename,
}: {
  headline: string;
  activeChannel: string | null;
  isHome: boolean;
  /** Renames the channel; the page follows it. Reports its own errors. */
  onRename: (oldName: string, newName: string) => Promise<void>;
}) {
  const { can } = useAuth();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const submitRename = async (oldName: string) => {
    const next = renameValue.trim();
    setRenaming(null);
    if (!next || next === oldName) return;
    await onRename(oldName, next);
  };

  if (activeChannel && renaming === activeChannel) {
    return (
      <input
        ref={focusOnMount}
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={() => submitRename(activeChannel)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitRename(activeChannel);
          if (e.key === "Escape") setRenaming(null);
        }}
        className="rounded-lg border border-accent bg-ink-950 px-3 py-1 text-2xl font-bold text-gray-100 outline-none"
      />
    );
  }
  return (
    <h1
      className={`group ${
        isHome ? "sr-only lg:not-sr-only lg:flex" : "flex"
      } shrink-0 items-center gap-2 text-2xl font-bold text-gray-100`}
    >
      {headline}
      {activeChannel && can("edit_metadata") && (
        <button
          onClick={() => {
            setRenameValue(activeChannel);
            setRenaming(activeChannel);
          }}
          title="Rename channel"
          className="text-base text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          ✎
        </button>
      )}
    </h1>
  );
}
