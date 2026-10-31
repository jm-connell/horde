import { Link } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useAskChannels } from "../../../queries/ask";
import AddAskChannel from "../../ask/AddAskChannel";
import { askProgressText, findAskChannel } from "../../ask/askLinks";
import SettingsSection from "./SettingsSection";

/** Whether Ask indexes this channel's captions, and turning it on. */
export default function AskSection({
  channel,
  channelUrl,
}: {
  channel: string;
  channelUrl: string | null;
}) {
  const { can } = useAuth();
  const manage = can("manage_ask");
  const channels = useAskChannels(true, { poll: true });
  const found = findAskChannel(channels.data?.items ?? [], channelUrl, channel);
  return (
    <SettingsSection
      id="ask"
      title="Ask"
      description="Index what this channel says in its videos, so you can search it and ask questions about it."
      readOnlyNote={
        found || manage
          ? null
          : "Turning Ask on needs the Manage Ask channels permission."
      }
    >
      {found ? (
        <p className="text-sm text-gray-300">
          On · {askProgressText(found)}.{" "}
          <Link to="/ask" className="text-accent hover:underline">
            Manage in Ask
          </Link>
        </p>
      ) : manage && channelUrl ? (
        <AddAskChannel initialUrl={channelUrl} />
      ) : (
        <p className="text-sm text-muted">Off</p>
      )}
    </SettingsSection>
  );
}
