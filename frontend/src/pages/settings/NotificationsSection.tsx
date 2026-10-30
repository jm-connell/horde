import { useState } from "react";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { useConfirm } from "../../context/ConfirmContext";
import {
  useCreateNotificationTarget,
  useDeleteNotificationTarget,
  useNotifications,
  useUpdateNotificationTarget,
} from "../../queries/notifications";
import type {
  NotificationEvent,
  NotificationTarget,
  NotificationTestResult,
} from "../../types";
import { PANEL_BTN } from "./constants";
import { useSettingsPage } from "./context";
import NotificationTargetForm, { TestResult } from "./NotificationTargetForm";
import { KIND_LABELS } from "./notificationKinds";
import { Section, Toggle } from "./ui";
import { button } from "../../components/buttons";

const TERMS = [
  "notifications",
  "notify",
  "alerts",
  "push",
  "ntfy",
  "discord",
  "webhook",
  "message",
  "failed download",
];

const SMALL_BTN = button("secondary", "xs");
const DANGER_SMALL_BTN = button("danger", "xs");

/** What a target sends, in words: "Download failed, Update failed". */
function eventsSummary(
  target: NotificationTarget,
  events: NotificationEvent[]
): string {
  const labels = events
    .filter((e) => target.events.includes(e.name))
    .map((e) => e.label);
  return labels.length ? labels.join(", ") : "No events selected";
}

/** Where Horde sends messages (ntfy, Discord, webhooks) and for which events. */
export default function NotificationsSection() {
  const { match, showToast, showError } = useSettingsPage();
  const confirm = useConfirm();
  const query = useNotifications();
  const create = useCreateNotificationTarget();
  const update = useUpdateNotificationTarget();
  const remove = useDeleteNotificationTarget();
  // "new", a target id being edited, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [results, setResults] = useState<
    Record<string, NotificationTestResult | undefined>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const config = query.data;
  const targets = config?.targets ?? [];
  const events = config?.events ?? [];
  const atLimit = config ? targets.length >= config.max_targets : false;

  const sendTest = async (target: NotificationTarget) => {
    setTestingId(target.id);
    setResults((prev) => ({ ...prev, [target.id]: undefined }));
    try {
      const result = await api.testNotificationTarget(target.id);
      setResults((prev) => ({ ...prev, [target.id]: result }));
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [target.id]: {
          ok: false,
          error: describeError(err, "Could not send the test"),
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const setEnabled = async (target: NotificationTarget) => {
    try {
      await update.mutateAsync({
        id: target.id,
        body: { enabled: !target.enabled },
      });
    } catch (err) {
      showError(`Could not change ${target.name}: ${describeError(err)}`);
    }
  };

  const deleteTarget = async (target: NotificationTarget) => {
    const ok = await confirm({
      title: `Delete ${target.name}?`,
      body: "Horde stops sending notifications there.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(target.id);
      showToast(`Deleted ${target.name}`);
    } catch (err) {
      showError(`Could not delete ${target.name}: ${describeError(err)}`);
    }
  };

  return (
    <Section
      anchor="notifications"
      title="Notifications"
      description="Send a message to ntfy, Discord or any webhook when something needs you, such as a failed download or a full disk. Nothing is sent until you add a target."
      hidden={!match(...TERMS)}
    >
      <div className="space-y-3">
        {query.isError && (
          <p role="alert" className="text-xs text-danger">
            Could not load notification targets: {describeError(query.error)}
          </p>
        )}
        {config && !config.public_url_set && (
          <p className="max-w-2xl text-xs text-muted">
            Messages carry no link back to Horde. Set{" "}
            <span className="font-mono">HORDE_PUBLIC_URL</span> to the address
            you open Horde at to add one.
          </p>
        )}

        {targets.length > 0 && (
          <ul className="space-y-2">
            {targets.map((target) => (
              <li key={target.id}>
                {editing === target.id ? (
                  <NotificationTargetForm
                    target={target}
                    events={events}
                    saving={update.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={async (body) => {
                      try {
                        await update.mutateAsync({ id: target.id, body });
                        setEditing(null);
                        setResults((prev) => ({
                          ...prev,
                          [target.id]: undefined,
                        }));
                        showToast(`Saved ${body.name}`);
                      } catch (err) {
                        showError(`Could not save: ${describeError(err)}`);
                      }
                    }}
                  />
                ) : (
                  <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <Toggle
                        label={`Send notifications to ${target.name}`}
                        checked={target.enabled}
                        disabled={update.isPending}
                        onChange={() => void setEnabled(target)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-200">
                          {target.name}{" "}
                          <span className="ml-1 rounded-full border border-ink-600 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wider text-muted">
                            {KIND_LABELS[target.kind]}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted">
                          {eventsSummary(target, events)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={testingId === target.id}
                          onClick={() => void sendTest(target)}
                          className={SMALL_BTN}
                          aria-label={`Send test to ${target.name}`}
                        >
                          {testingId === target.id ? "Sending…" : "Send test"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(target.id)}
                          className={SMALL_BTN}
                          aria-label={`Edit ${target.name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={remove.isPending}
                          onClick={() => void deleteTarget(target)}
                          className={DANGER_SMALL_BTN}
                          aria-label={`Delete ${target.name}`}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {results[target.id] && (
                      <div className="mt-2">
                        <TestResult result={results[target.id]!} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {editing === "new" && (
          <NotificationTargetForm
            events={events}
            saving={create.isPending}
            onCancel={() => setEditing(null)}
            onSave={async (body) => {
              try {
                await create.mutateAsync(body);
                setEditing(null);
                showToast(`Added ${body.name}`);
              } catch (err) {
                showError(`Could not add: ${describeError(err)}`);
              }
            }}
          />
        )}

        {editing === null && config && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={atLimit}
              onClick={() => setEditing("new")}
              className={PANEL_BTN}
            >
              Add target
            </button>
            {atLimit && (
              <p className="text-xs text-muted">
                You can have up to {config.max_targets} targets.
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
