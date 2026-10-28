import { Link } from "react-router-dom";
import { useSettings } from "../../../hooks/useSettings";
import { useChannelFollow } from "../../../queries/follows";
import { Toggle } from "../../settings/ui";
import SettingsSection from "./SettingsSection";

/** Whether this account follows the channel, which drives the sidebar's Live list. */
export default function FollowSection({
  channel,
  channelUrl,
}: {
  channel: string;
  channelUrl: string | null;
}) {
  const [settings] = useSettings();
  const follow = useChannelFollow(channelUrl, channel);
  return (
    <SettingsSection
      id="following"
      title="Live & following"
      description="Followed channels show in the sidebar’s Live list while they stream. Following is just for your account."
    >
      {follow.followable ? (
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-gray-200">
              Follow this channel
            </span>
            <Toggle
              checked={follow.followed}
              disabled={follow.pending}
              onChange={follow.toggle}
            />
          </label>
          {!settings.showLiveStreams && (
            <p className="text-xs text-muted">
              The Live list is turned off in{" "}
              <Link
                to="/settings?tab=library"
                className="text-accent hover:underline"
              >
                Settings → Library
              </Link>
              .
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-400">
          Only YouTube channels can be followed.
        </p>
      )}
    </SettingsSection>
  );
}
