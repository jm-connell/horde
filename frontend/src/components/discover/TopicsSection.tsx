import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api";
import { useToast } from "../../context/ToastContext";
import {
  useAddRecTopic,
  useDeleteRecTopic,
  useRecTopics,
  useUpdateRecTopic,
} from "../../queries/discover";
import { queryKeys } from "../../queries/keys";
import type { DiscoverBlocked, RecTopic } from "../../types";
import { button } from "../buttons";
import { CloseIcon } from "../icons";
import ThemedSelect from "../ThemedSelect";

type Kind = RecTopic["kind"];
type Expiry = "never" | "7" | "14" | "30" | "date";

const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: "never", label: "Always" },
  { value: "7", label: "For a week" },
  { value: "14", label: "For 2 weeks" },
  { value: "30", label: "For a month" },
  { value: "date", label: "Until a date…" },
];
const STRENGTH_OPTIONS: { value: RecTopic["strength"]; label: string }[] = [
  { value: "low", label: "A little" },
  { value: "normal", label: "Some" },
  { value: "high", label: "A lot" },
];
const MATCH_OPTIONS: { value: RecTopic["match"]; label: string }[] = [
  { value: "words", label: "These words" },
  { value: "similar", label: "Similar topics" },
];

/** When an expiry choice ends (null: never); a date runs to the end of that day. */
function expiryFor(choice: Expiry, date: string): string | null {
  if (choice === "never") return null;
  if (choice === "date") {
    if (!date) return null;
    return new Date(`${date}T23:59:59`).toISOString();
  }
  return new Date(Date.now() + Number(choice) * 86_400_000).toISOString();
}

function expiryLabel(topic: RecTopic): string {
  if (!topic.active) return "Expired";
  if (!topic.expires_at) return "Always";
  const when = new Date(topic.expires_at);
  return `Until ${when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      when.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  })}`;
}

/** Today in the browser's own calendar, as a date input wants it. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function AddTopic({ kind }: { kind: Kind }) {
  const { showError } = useToast();
  const add = useAddRecTopic();
  const textId = useId();
  const dateId = useId();
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [date, setDate] = useState("");
  const [match, setMatch] = useState<RecTopic["match"]>("words");
  const today = localToday();
  const ready = text.trim().length > 0 && (expiry !== "date" || date >= today);

  const submit = () => {
    if (!ready) return;
    add.mutate(
      {
        kind,
        text: text.trim(),
        match,
        strength: "normal",
        expires_at: expiryFor(expiry, date),
      },
      {
        onSuccess: () => {
          setText("");
          setExpiry("never");
          setDate("");
        },
        onError: (err) => showError(errorText(err, "Could not add that")),
      }
    );
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={textId} className="sr-only">
        {kind === "interest" ? "Add an interest" : "Block a topic"}
      </label>
      <input
        id={textId}
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          kind === "interest"
            ? "e.g. Europe travel vlogs"
            : "e.g. reaction videos"
        }
        className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-100 outline-hidden placeholder:text-muted focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <ThemedSelect
          value={expiry}
          options={EXPIRY_OPTIONS}
          onChange={setExpiry}
          size="compact"
          aria-label={
            kind === "interest"
              ? "How long the interest lasts"
              : "How long the block lasts"
          }
        />
        {kind === "block" && (
          <ThemedSelect
            value={match}
            options={MATCH_OPTIONS}
            onChange={setMatch}
            size="compact"
            aria-label="What the block matches"
          />
        )}
        {expiry === "date" && (
          <>
            <label htmlFor={dateId} className="sr-only">
              Last day
            </label>
            <input
              id={dateId}
              type="date"
              min={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="ui-panel rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-gray-100 outline-hidden focus:border-accent"
            />
          </>
        )}
        <span className="flex-1" />
        <button
          type="submit"
          disabled={!ready || add.isPending}
          className={button("secondary", "sm")}
        >
          {kind === "interest" ? "Add" : "Block"}
        </button>
      </div>
    </form>
  );
}

function TopicRow({
  topic,
  hidden,
}: {
  topic: RecTopic;
  /** Videos this block left out of the latest feed. */
  hidden: number | undefined;
}) {
  const { showError } = useToast();
  const update = useUpdateRecTopic();
  const remove = useDeleteRecTopic();
  const change = (payload: Parameters<typeof update.mutate>[0]["payload"]) =>
    update.mutate(
      { id: topic.id, payload },
      { onError: (err) => showError(errorText(err, "Could not change that")) }
    );
  return (
    <li
      className="space-y-1.5 rounded-lg px-2 py-1.5 hover:bg-ink-800"
      data-topic={topic.text}
    >
      <div className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm ${topic.active ? "text-gray-200" : "text-muted line-through"}`}
        >
          {topic.text}
        </span>
        <span
          className={`shrink-0 text-xs ${topic.active ? "text-muted" : "text-warning"}`}
        >
          {expiryLabel(topic)}
        </span>
        <button
          type="button"
          onClick={() =>
            remove.mutate(topic.id, {
              onError: () => showError("Could not delete that"),
            })
          }
          aria-label={`Delete ${topic.text}`}
          title="Delete"
          className="shrink-0 rounded-md p-1 text-muted hover:text-danger"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {topic.kind === "interest" ? (
          <ThemedSelect
            value={topic.strength}
            options={STRENGTH_OPTIONS}
            onChange={(strength) => change({ strength })}
            size="compact"
            aria-label={`How much of ${topic.text}`}
          />
        ) : (
          <ThemedSelect
            value={topic.match}
            options={MATCH_OPTIONS}
            onChange={(match) => change({ match })}
            size="compact"
            aria-label={`What blocking ${topic.text} matches`}
          />
        )}
        {!topic.active && (
          <ThemedSelect<Expiry | "">
            value=""
            options={[
              { value: "", label: "Turn on again…" },
              ...EXPIRY_OPTIONS.filter((o) => o.value !== "date"),
            ]}
            onChange={(choice) =>
              choice && change({ expires_at: expiryFor(choice, "") })
            }
            size="compact"
            aria-label={`Turn ${topic.text} on again`}
          />
        )}
        {topic.kind === "block" && topic.active && hidden ? (
          <span className="text-xs text-muted">
            Hid {hidden} {hidden === 1 ? "video" : "videos"}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Topics you type in: interests (shown more, and searched for on YouTube) and
 * blocked topics, each for good or until a date. They are yours, not part of
 * an algorithm, so they stay when you switch presets.
 */
export default function TopicsSection() {
  const topics = useRecTopics().data?.items ?? [];
  const blocked = useQuery<DiscoverBlocked[]>({
    queryKey: queryKeys.discover.blocked,
    queryFn: () => [],
    enabled: false,
    staleTime: Infinity,
  }).data;
  const hidden = new Map((blocked ?? []).map((b) => [b.topic_id, b.count]));
  const interests = topics.filter((t) => t.kind === "interest");
  const blocks = topics.filter((t) => t.kind === "block");

  return (
    <>
      <section className="space-y-2" aria-labelledby="tuning-interests">
        <h3
          id="tuning-interests"
          className="text-[11px] font-semibold uppercase tracking-wider text-gray-400"
        >
          Your interests
        </h3>
        <p className="text-xs text-muted">
          Get more of a topic, and Horde searches YouTube for it. Set it to end,
          say after a trip.
        </p>
        {interests.length > 0 && (
          <ul className="space-y-1">
            {interests.map((t) => (
              <TopicRow key={t.id} topic={t} hidden={undefined} />
            ))}
          </ul>
        )}
        <AddTopic kind="interest" />
      </section>
      <section className="space-y-2" aria-labelledby="tuning-blocks">
        <h3
          id="tuning-blocks"
          className="text-[11px] font-semibold uppercase tracking-wider text-gray-400"
        >
          Blocked topics
        </h3>
        <p className="text-xs text-muted">
          Leave a topic out, for good or for a while. Similar topics catch more
          but are a best guess; the words block also applies to Recommended.
        </p>
        {blocks.length > 0 && (
          <ul className="space-y-1">
            {blocks.map((t) => (
              <TopicRow key={t.id} topic={t} hidden={hidden.get(t.id)} />
            ))}
          </ul>
        )}
        <AddTopic kind="block" />
      </section>
    </>
  );
}
