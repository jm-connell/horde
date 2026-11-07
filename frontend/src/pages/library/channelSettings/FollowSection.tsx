import { Link } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useSettings } from "../../../hooks/useSettings";
import { useChannelFollow } from "../../../queries/follows";
import { Toggle } from "../../settings/ui";
import SettingsSection from "./SettingsSection";

/**
 * Whether this account subscribes to the channel (which drives the sidebar's
 * Live list and Recommended+), and whether its live streams show.
 */
export default function FollowSection({
  channel,
  channelUrl,
}: {
  channel: string;
  channelUrl: string | null;
}) {
  const [settings] = useSettings();
  const { can } = useAuth();
  const allowed = can("manage_subscriptions");
  const follow = useChannelFollow(channelUrl, channel);
  return (
    <SettingsSection
      id="following"
      title="Subscription"
      description="Subscribed channels show in the sidebar’s Live list while they stream, and their new uploads in Recommended+. Your subscriptions are just for your account."
      readOnlyNote={
        allowed ? null : "Changing subscriptions needs a permission."
      }
    >
      {follow.followable ? (
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-gray-200">
              Subscribe to this channel
            </span>
            <Toggle
              checked={follow.followed}
              disabled={follow.pending || !allowed}
              onChange={follow.toggle}
            />
          </label>
          {follow.followed && (
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-gray-200">
                  Show its live streams
                </span>
                <span className="block text-xs text-muted">
                  In the Live list and Recommended.
                </span>
              </span>
              <Toggle
                label="Show its live streams"
                checked={!follow.liveHidden}
                disabled={follow.pending}
                onChange={() => follow.setLiveHidden(!follow.liveHidden)}
              />
            </label>
          )}
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
          Only YouTube channels can be subscribed to.
        </p>
      )}
    </SettingsSection>
  );
}
