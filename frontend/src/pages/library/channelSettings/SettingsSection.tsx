import type { ReactNode } from "react";
import { sectionId, type ChannelSettingsSection } from "./channelSettingsText";

export const fieldLabel = "mb-1 block text-xs font-medium text-gray-400";
export const numberInput =
  "w-20 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-gray-100 outline-hidden focus:border-accent disabled:opacity-50";

/** One titled block of the channel settings sheet, with a one-line explanation. */
export default function SettingsSection({
  id,
  title,
  description,
  readOnlyNote,
  children,
}: {
  id: ChannelSettingsSection;
  title: string;
  description: string;
  /** Shown when the account may look but not change this section. */
  readOnlyNote?: string | null;
  children: ReactNode;
}) {
  const headingId = `${sectionId(id)}-title`;
  return (
    <section
      id={sectionId(id)}
      aria-labelledby={headingId}
      className="scroll-mt-2 border-t border-ink-700 px-5 py-5 first:border-t-0"
    >
      <h3
        id={headingId}
        tabIndex={-1}
        className="text-sm font-semibold text-gray-100 outline-hidden"
      >
        {title}
      </h3>
      <p className="mt-0.5 text-xs text-muted">{description}</p>
      {readOnlyNote && (
        <p className="mt-2 text-xs text-warning">{readOnlyNote}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}
