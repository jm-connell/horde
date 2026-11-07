import { describeError } from "../apiErrors";
import { useToast } from "../context/ToastContext";
import { useSubscribe, useUnfollowMutation } from "../queries/follows";
import type { SubscribePrompt } from "../types";

/**
 * On a finished download from a channel new to the user, when the
 * administrator chose to ask: subscribe, or say no (which is remembered, so
 * the channel is not offered again).
 */
export default function SubscribePromptTag({
  prompt,
  onAnswered,
}: {
  prompt: SubscribePrompt;
  onAnswered: () => void;
}) {
  const { showError, showToast } = useToast();
  const { subscribe, pending } = useSubscribe();
  const decline = useUnfollowMutation();
  const name = prompt.channel_name ?? prompt.channel_url;
  const busy = pending || decline.isPending;

  const onSubscribe = async () => {
    try {
      await subscribe(prompt.channel_url, prompt.channel_name);
      showToast(`Subscribed to ${name}`);
      onAnswered();
    } catch (err) {
      showError(`Could not subscribe: ${describeError(err)}`);
    }
  };

  const onDecline = () =>
    decline.mutate(prompt.channel_url, {
      onSuccess: onAnswered,
      onError: (err) => showError(`Could not save that: ${describeError(err)}`),
    });

  return (
    <div
      role="group"
      aria-label={`New channel: ${name}`}
      className="mt-3 inline-flex max-w-full items-center gap-2 rounded-lg bg-accent/10 py-1 pl-2.5 pr-1 text-xs ring-1 ring-accent/30"
    >
      <span className="min-w-0 truncate text-gray-200">
        <span className="font-medium text-accent">New channel</span> · {name}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onSubscribe()}
        className="shrink-0 rounded-md bg-accent px-2 py-0.5 font-semibold text-on-accent hover:bg-accent-soft disabled:opacity-50"
      >
        Subscribe
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDecline}
        title="Don't ask about this channel again"
        className="shrink-0 rounded-md px-1.5 py-0.5 text-muted hover:text-gray-200 disabled:opacity-50"
      >
        No thanks
      </button>
    </div>
  );
}
