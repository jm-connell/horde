import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { appSettingsQuery, useUpdateAppSettings } from "../../queries/app";
import { queryKeys } from "../../queries/keys";
import type { NewChannelMode } from "../../types";
import { useSettingsPage } from "./context";
import { Chip, SettingRow, Toggle } from "./ui";

const MODES: { value: NewChannelMode; label: string }[] = [
  { value: "always", label: "Subscribe" },
  { value: "ask", label: "Ask on the download" },
  { value: "never", label: "Never" },
];

/**
 * Settings → Library → Subscriptions: a way to the Subscriptions page and,
 * for the administrator, what a download from a new channel does.
 */
export default function SubscriptionsSection() {
  const { isAdmin } = useAuth();
  const { q, match, showError } = useSettingsPage();
  const settings = useQuery(appSettingsQuery()).data;
  const save = useUpdateAppSettings();
  const users = useQuery({
    queryKey: queryKeys.users.list,
    queryFn: () => api.listUsers(),
    enabled: isAdmin,
  }).data;
  const hasMembers = (users ?? []).some((u) => !u.is_admin);
  const mode = settings?.new_channel_subscribe ?? "always";

  const change = (patch: Parameters<typeof save>[0]) =>
    save(patch).catch((err: unknown) =>
      showError(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`
      )
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">
        <Link to="/subscriptions" className="text-accent underline">
          Your subscriptions
        </Link>{" "}
        list each channel you subscribe to, with its automatic downloads,
        cleanup and Ask indexing.
      </p>
      {isAdmin && settings && (
        <div
          data-setting="new-channel-subscribe"
          hidden={!!q && !match("new channels", "subscribe", "downloads")}
        >
          <h3 className="text-sm font-medium text-gray-200">
            New channels from downloads
          </h3>
          <p className="mb-2 text-xs text-muted">
            When a download finishes from a channel its owner does not subscribe
            to (and never unsubscribed from).
          </p>
          <div className="flex flex-wrap gap-2">
            {MODES.map((m) => (
              <Chip
                key={m.value}
                active={mode === m.value}
                onClick={() => void change({ new_channel_subscribe: m.value })}
              >
                {m.label}
              </Chip>
            ))}
          </div>
        </div>
      )}
      {isAdmin && settings && mode !== "never" && hasMembers && (
        <SettingRow
          anchor="new-channel-members"
          title="Include new channels from members"
          description="Members' downloads count too, and their subscriptions may turn Ask on for channels up to 500 videos."
          hidden={!!q && !match("members", "new channels", "subscribe")}
          control={
            <Toggle
              checked={settings.new_channel_subscribe_members}
              onChange={() =>
                void change({
                  new_channel_subscribe_members:
                    !settings.new_channel_subscribe_members,
                })
              }
            />
          }
        />
      )}
    </div>
  );
}
