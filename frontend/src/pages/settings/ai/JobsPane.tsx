import { api } from "../../../api";
import ThemedSelect from "../../../components/ThemedSelect";
import Collapse from "../../../components/Collapse";
import type { AiSchedule } from "../../../types";
import AiQueueStatus from "../AiQueueStatus";
import { useSettingsPage } from "../context";
import { ProcessActionRow, Section } from "../ui";
import { AI_SCHEDULE_OPTIONS, INPUT_COMPACT, PANEL_BTN } from "../constants";

export default function JobsPane() {
  const {
    q,
    match,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    systemStats,
    showToast,
    aiProcessingAction,
    runAiProcess,
    catchUpScope,
    setCatchUpScope,
    individualStepsOpen,
    setIndividualStepsOpen,
    reindexPrompt,
    setReindexPrompt,
  } = useSettingsPage();

  return (
    <>
      <Section
        first
        title="Queue"
        description="Live AI job status and pause/resume."
        hidden={!match("queue", "indexed", "pause", "resume", "process", "gpu jobs")}
      >
        {aiStatus ? (
          <AiQueueStatus
            aiStatus={aiStatus}
            systemStats={systemStats}
            onPause={async () => {
              await api.pauseAi().catch(() => undefined);
              await saveAi({ paused: true });
              showToast("AI queue paused");
            }}
            onResume={async () => {
              await api.resumeAi().catch(() => undefined);
              await saveAi({ paused: false });
              showToast("AI queue resumed");
            }}
          />
        ) : (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
        {aiStatus?.paused && (
          <p className="mt-2 text-xs text-amber-400/90">
            Queue is paused — jobs won’t run until you resume.
          </p>
        )}
        {reindexPrompt && (
          <div className="ui-panel mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
            <p>{reindexPrompt}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={PANEL_BTN}
                onClick={() => {
                  setReindexPrompt(null);
                  void runAiProcess("reindex_embeds");
                }}
              >
                Rebuild indexes
              </button>
              <button
                type="button"
                className={PANEL_BTN}
                onClick={() => setReindexPrompt(null)}
              >
                Not now
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Automatic"
        description="When Horde queues AI work on its own. Important for large libraries."
        hidden={
          !match(
            "when to run",
            "schedule",
            "timer",
            "set time",
            "on download",
            "on request",
            "automatic"
          )
        }
      >
        <div className="max-w-md space-y-3">
          <ThemedSelect
            aria-label="AI schedule"
            value={aiDraft.schedule}
            options={AI_SCHEDULE_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            onChange={(value) => saveAi({ schedule: value as AiSchedule })}
            className="w-full max-w-sm"
            buttonClassName="w-full"
          />
          <p className="text-xs text-gray-500">
            {
              AI_SCHEDULE_OPTIONS.find((o) => o.value === aiDraft.schedule)
                ?.description
            }
          </p>
          {aiDraft.schedule === "timer" && (
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">
                Timer interval (hours)
              </span>
              <input
                type="number"
                min={0.25}
                max={168}
                step={0.25}
                value={aiDraft.timer_hours}
                onChange={(e) =>
                  setAiDraft((d) => ({
                    ...d,
                    timer_hours: Number(e.target.value) || 6,
                  }))
                }
                onBlur={(e) =>
                  saveAi({
                    timer_hours: Number(e.target.value) || 6,
                  })
                }
                className={INPUT_COMPACT}
              />
            </label>
          )}
          {aiDraft.schedule === "set_time" && (
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">
                Daily run time (local)
              </span>
              <input
                type="time"
                value={aiDraft.schedule_time || "03:00"}
                onChange={(e) =>
                  setAiDraft((d) => ({
                    ...d,
                    schedule_time: e.target.value || "03:00",
                  }))
                }
                onBlur={(e) =>
                  saveAi({
                    schedule_time: e.target.value || "03:00",
                  })
                }
                className={INPUT_COMPACT}
              />
            </label>
          )}
        </div>
      </Section>

      <Section
        title="Run now"
        description="Queue search indexing, tagging, and category jobs on demand."
        hidden={
          !match(
            "process",
            "run all",
            "recent",
            "full",
            "embeds",
            "index",
            "rebuild",
            "reindex",
            "tags",
            "categories",
            "catch up",
            "run now"
          )
        }
      >
        <div className="space-y-3">
          <div>
            <p className="mb-2 text-sm font-medium text-gray-200">Catch up</p>
            <p className="mb-3 text-xs text-gray-500">
              Queue missing search indexes and AI tags, then refresh categories.
            </p>
            <div className="ui-panel mb-3 flex max-w-md rounded-lg border border-ink-700 bg-ink-900 p-0.5">
              <button
                type="button"
                onClick={() => setCatchUpScope("all_recent")}
                className={
                  catchUpScope === "all_recent"
                    ? "flex-1 rounded-md bg-ink-800 px-3 py-1.5 text-xs font-medium text-accent"
                    : "flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200"
                }
              >
                Recent (30 days)
              </button>
              <button
                type="button"
                onClick={() => setCatchUpScope("all_full")}
                className={
                  catchUpScope === "all_full"
                    ? "flex-1 rounded-md bg-ink-800 px-3 py-1.5 text-xs font-medium text-accent"
                    : "flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200"
                }
              >
                Whole library
                <span className="ml-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                  Heavy
                </span>
              </button>
            </div>
            <button
              type="button"
              disabled={!!aiProcessingAction || !!aiStatus?.paused}
              onClick={() => runAiProcess(catchUpScope)}
              className={PANEL_BTN}
            >
              {aiProcessingAction === catchUpScope ? "Queuing…" : "Run catch-up"}
            </button>
          </div>

          <div className="border-t border-ink-800 pt-3">
            <button
              type="button"
              onClick={() => setIndividualStepsOpen((o) => !o)}
              className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-300"
            >
              {individualStepsOpen || Boolean(q)
                ? "Hide individual steps"
                : "Show individual steps"}
            </button>
            <Collapse open={individualStepsOpen || Boolean(q)}>
              <div className="space-y-4">
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
                    Search index
                  </p>
                  <div className="divide-y divide-ink-800">
                    <ProcessActionRow
                      label="Index missing videos"
                      description="Build search indexes for videos that are missing, stale, or indexed with a different embed model."
                      busy={aiProcessingAction === "embeds"}
                      disabled={!!aiProcessingAction || !!aiStatus?.paused}
                      onClick={() => runAiProcess("embeds")}
                    />
                    <ProcessActionRow
                      label="Rebuild all indexes"
                      description="Force re-queue indexing for those videos (even if already queued) and refresh categories when done. Prefer this after changing the embed model."
                      heavy
                      busy={aiProcessingAction === "reindex_embeds"}
                      disabled={!!aiProcessingAction || !!aiStatus?.paused}
                      onClick={() => runAiProcess("reindex_embeds")}
                    />
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
                    Tags
                  </p>
                  <div className="divide-y divide-ink-800">
                    <ProcessActionRow
                      label="Tag untagged videos"
                      description="Ask the chat model to suggest tags only for videos that do not have AI tags yet."
                      busy={aiProcessingAction === "missing_tags"}
                      disabled={!!aiProcessingAction || !!aiStatus?.paused}
                      onClick={() => runAiProcess("missing_tags")}
                    />
                    <ProcessActionRow
                      label="Re-tag everything"
                      description="Re-run AI tag enrichment for every unlocked video. Heavier than tagging untagged videos only."
                      heavy
                      busy={aiProcessingAction === "full_tags"}
                      disabled={!!aiProcessingAction || !!aiStatus?.paused}
                      onClick={() => runAiProcess("full_tags")}
                    />
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
                    Categories
                  </p>
                  <div className="divide-y divide-ink-800">
                    <ProcessActionRow
                      label="Refresh categories"
                      description="Invent browse categories from a diverse sample, then rematch shelves via search indexes. Run after re-indexing if you changed the embed model."
                      busy={aiProcessingAction === "categories"}
                      disabled={!!aiProcessingAction || !!aiStatus?.paused}
                      onClick={() => runAiProcess("categories")}
                    />
                  </div>
                </div>
              </div>
            </Collapse>
          </div>
        </div>
      </Section>
    </>
  );
}
