import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { HelpDataConsent } from "../../hooks/settings/types";
import { queryKeys } from "../../queries/keys";
import { useSettingsPage } from "./context";
import { Chip } from "./ui";

const CHOICES: { value: HelpDataConsent; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "local", label: "AI on my network only" },
  { value: "cloud", label: "Any AI, including cloud" },
];

/** Settings → Library: what Ask about Horde may read of this account's data. */
export default function HelpDataSection() {
  const { settings, update } = useSettingsPage();
  const info = useQuery({
    queryKey: queryKeys.ai.helpInfo,
    queryFn: ({ signal }) => api.getHelpInfo({ signal }),
  }).data;
  const consent = settings.helpChatData;
  const where = info?.provider_label || "the AI service";

  let status: string | null = null;
  if (info?.available && consent !== "off") {
    status = info.local
      ? `Your AI is ${where}: your data stays there.`
      : consent === "cloud"
        ? `Your AI is ${where}: what a question needs is sent there.`
        : `Your AI is ${where}, so nothing is sent until you choose “Any AI, including cloud”.`;
  }

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Use my data"
        className="flex flex-wrap gap-2"
      >
        {CHOICES.map((choice) => (
          <Chip
            key={choice.value}
            active={consent === choice.value}
            onClick={() => update({ helpChatData: choice.value })}
          >
            {choice.label}
          </Chip>
        ))}
      </div>
      {status && <p className="text-xs text-muted">{status}</p>}
    </div>
  );
}
