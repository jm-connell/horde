import { useId, useState } from "react";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import type {
  NotificationEvent,
  NotificationKind,
  NotificationTarget,
  NotificationTargetCreate,
  NotificationTestResult,
} from "../../types";
import { INPUT, PANEL_BTN } from "./constants";
import { KIND_HINTS, KIND_LABELS, URL_PLACEHOLDERS } from "./notificationKinds";
import { Chip } from "./ui";

const SAVE_BTN =
  "ui-interactive rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50";

export function TestResult({ result }: { result: NotificationTestResult }) {
  return result.ok ? (
    <p role="status" className="text-xs text-success">
      Sent (HTTP {result.status_code}). Check that it arrived.
    </p>
  ) : (
    <p role="alert" className="text-xs text-danger">
      Not delivered: {result.error ?? "unknown error"}
    </p>
  );
}

type Props = {
  /** The target being edited; undefined adds a new one. */
  target?: NotificationTarget;
  events: NotificationEvent[];
  saving: boolean;
  onSave: (body: NotificationTargetCreate) => void;
  onCancel: () => void;
};

/** Add or edit one notification target. */
export default function NotificationTargetForm({
  target,
  events,
  saving,
  onSave,
  onCancel,
}: Props) {
  const idPrefix = useId();
  const [name, setName] = useState(target?.name ?? "");
  const [kind, setKind] = useState<NotificationKind>(target?.kind ?? "ntfy");
  const [url, setUrl] = useState(target?.url ?? "");
  const [topic, setTopic] = useState(target?.topic ?? "");
  // Empty means "keep the saved token"; the server never sends the real one.
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [selected, setSelected] = useState<string[]>(
    target?.events ?? events.filter((e) => e.default).map((e) => e.name)
  );
  const [options, setOptions] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {};
    for (const e of events)
      for (const o of e.options ?? []) defaults[o.key] = o.default;
    return { ...defaults, ...(target?.options ?? {}) };
  });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<NotificationTestResult | null>(null);

  const usesToken = kind !== "discord";
  const tokenSaved = Boolean(target?.token_set) && !removeToken;
  const ready =
    name.trim() !== "" &&
    url.trim() !== "" &&
    (kind !== "ntfy" || topic.trim());

  const body = (): NotificationTargetCreate => ({
    name: name.trim(),
    kind,
    url: url.trim(),
    topic: kind === "ntfy" ? topic.trim() : null,
    // null keeps the saved token, "" removes it, text replaces it.
    token: !usesToken ? "" : removeToken ? "" : token.trim() || null,
    enabled: target?.enabled ?? true,
    events: selected,
    options,
  });

  const toggleEvent = (eventName: string) =>
    setSelected((prev) =>
      prev.includes(eventName)
        ? prev.filter((n) => n !== eventName)
        : [...prev, eventName]
    );

  const sendTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testNotificationDraft({ ...body(), id: target?.id }));
    } catch (err) {
      setResult({
        ok: false,
        error: describeError(err, "Could not send the test"),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      aria-label={target ? `Edit ${target.name}` : "Add notification target"}
      className="space-y-4 rounded-lg border border-ink-700 bg-ink-950/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !saving) onSave(body());
      }}
    >
      <div>
        <p className="mb-1.5 text-xs font-medium text-gray-300">Type</p>
        <div role="group" aria-label="Type" className="flex flex-wrap gap-2">
          {(Object.keys(KIND_LABELS) as NotificationKind[]).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
              {KIND_LABELS[k]}
            </Chip>
          ))}
        </div>
        <p className="mt-1.5 max-w-2xl text-xs text-muted">
          {KIND_HINTS[kind]}
        </p>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-300">
            Name
          </span>
          <input
            type="text"
            className={INPUT}
            value={name}
            maxLength={60}
            placeholder="My phone"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-300">
            {kind === "ntfy" ? "Server URL" : "Webhook URL"}
          </span>
          <input
            type="url"
            className={INPUT}
            value={url}
            placeholder={URL_PLACEHOLDERS[kind]}
            autoComplete="off"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        {kind === "ntfy" && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-300">
              Topic
            </span>
            <input
              type="text"
              className={INPUT}
              value={topic}
              maxLength={64}
              placeholder="horde-alerts"
              autoComplete="off"
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
        )}
        {usesToken && (
          <div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-300">
                Access token (optional)
              </span>
              <input
                type="password"
                className={INPUT}
                value={token}
                disabled={removeToken}
                placeholder={
                  tokenSaved ? `Saved (${target?.token}); type to replace` : ""
                }
                autoComplete="new-password"
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            {target?.token_set && (
              <label className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={removeToken}
                  onChange={(e) => {
                    setRemoveToken(e.target.checked);
                    if (e.target.checked) setToken("");
                  }}
                />
                Remove the saved token
              </label>
            )}
          </div>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium text-gray-300">
          Send a notification when
        </legend>
        {events.map((event) => {
          const id = `${idPrefix}-${event.name}`;
          const checked = selected.includes(event.name);
          return (
            <div key={event.name}>
              <label htmlFor={id} className="flex items-start gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="mt-1"
                  checked={checked}
                  onChange={() => toggleEvent(event.name)}
                />
                <span>
                  <span className="block text-sm text-gray-200">
                    {event.label}
                  </span>
                  <span className="block text-xs text-muted">
                    {event.description}
                  </span>
                </span>
              </label>
              {checked &&
                (event.options ?? []).map((option) => (
                  <label
                    key={option.key}
                    className="ml-6 mt-1 flex items-start gap-2"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={options[option.key] ?? option.default}
                      onChange={(e) =>
                        setOptions((prev) => ({
                          ...prev,
                          [option.key]: e.target.checked,
                        }))
                      }
                    />
                    <span>
                      <span className="block text-sm text-gray-300">
                        {option.label}
                      </span>
                      <span className="block text-xs text-muted">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!ready || saving} className={SAVE_BTN}>
          {saving ? "Saving…" : target ? "Save" : "Add target"}
        </button>
        <button
          type="button"
          disabled={!ready || testing}
          onClick={() => void sendTest()}
          className={PANEL_BTN}
        >
          {testing ? "Sending…" : "Send test"}
        </button>
        <button type="button" onClick={onCancel} className={PANEL_BTN}>
          Cancel
        </button>
      </div>
      {result && <TestResult result={result} />}
    </form>
  );
}
