import type { NotificationKind } from "../../types";

export const KIND_LABELS: Record<NotificationKind, string> = {
  ntfy: "ntfy",
  webhook: "Webhook",
  discord: "Discord",
};

export const KIND_HINTS: Record<NotificationKind, string> = {
  ntfy: "Push notifications to your phone or desktop with ntfy. Use https://ntfy.sh or the address of your own server, plus a topic nobody else will guess.",
  webhook:
    "Horde POSTs a JSON message to the URL, for Home Assistant, n8n, Node-RED or your own script. An access token is sent as a bearer token.",
  discord:
    "Posts to a channel through its webhook (channel settings, Integrations, Webhooks, Copy Webhook URL).",
};

export const URL_PLACEHOLDERS: Record<NotificationKind, string> = {
  ntfy: "https://ntfy.sh",
  webhook: "https://example.com/hooks/horde",
  discord: "https://discord.com/api/webhooks/…",
};
