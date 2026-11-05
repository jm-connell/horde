import { useToast } from "../../context/ToastContext";
import { useHideLiveMutation } from "../../queries/follows";
import { normalizeChannelUrl } from "../../utils/followUrl";

/**
 * "Hide live streams from this channel" on a live card: the channel stays
 * followed, its broadcasts leave the feeds and the Live list. `onHidden`
 * takes its cards off screen; Undo shows them again on the next load.
 */
export function useHideLive(onHidden: (channelUrl: string) => void) {
  const { showToast, showError } = useToast();
  const mutation = useHideLiveMutation();
  return (channelUrl: string, channelName: string | null) => {
    const url = normalizeChannelUrl(channelUrl) ?? channelUrl;
    const name = channelName || "this channel";
    mutation.mutate(
      { url, hide: true },
      {
        onSuccess: () => {
          onHidden(url);
          showToast(`Live streams from ${name} are hidden`, {
            action: {
              label: "Undo",
              onClick: () => mutation.mutate({ url, hide: false }),
            },
          });
        },
        onError: () => showError("Could not hide those live streams"),
      }
    );
  };
}
