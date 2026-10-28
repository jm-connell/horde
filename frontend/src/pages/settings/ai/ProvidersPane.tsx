import HelpTip from "../../../components/HelpTip";
import ConnectionPane from "./ConnectionPane";
import CostsPane from "./CostsPane";
import { useSettingsPage } from "../context";
import { useAiPage } from "./aiPageContext";
import { Section } from "../ui";
import { PANEL_BTN, WORKLOAD_OPTIONS, WORKLOAD_TIP } from "../constants";

export default function ProvidersPane() {
  const { q, match } = useSettingsPage();
  const {
    aiDraft,
    aiStatus,
    reindexPrompt,
    setReindexPrompt,
    runAiProcess,
    applyWorkload,
  } = useAiPage();

  return (
    <>
      <Section
        first
        title="General"
        description="How much work AI jobs do, whatever the provider."
        hidden={
          !!q &&
          !match("workload", "light", "normal", "heavy", "gpu", "general")
        }
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
              Workload
              <HelpTip text={WORKLOAD_TIP} />
            </span>
            <div className="ui-panel flex rounded-lg border border-ink-700 bg-ink-900 p-0.5">
              {WORKLOAD_OPTIONS.map((opt) => {
                const locked =
                  Boolean(aiStatus?.profile_locked) && opt.value !== "light";
                const selected = aiDraft.workload_profile === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={selected}
                    disabled={locked}
                    onClick={() => void applyWorkload(opt.value)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      selected
                        ? "bg-accent/15 text-accent"
                        : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          {reindexPrompt && (
            <div className="ui-panel rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
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
          {aiStatus?.profile_locked && aiStatus.lock_reason && (
            <p className="text-xs text-amber-400/90">{aiStatus.lock_reason}</p>
          )}
          {aiStatus?.workload_warning && (
            <p className="text-xs text-amber-400/90">
              {aiStatus.workload_warning}
            </p>
          )}
          {aiStatus && aiStatus.models_match_profile === false && (
            <p className="text-xs text-muted">
              Ollama models differ from the workload’s picks — re-apply a
              workload to reset them for the Ollama GPU.
            </p>
          )}
        </div>
      </Section>

      <ConnectionPane />
      <CostsPane />
    </>
  );
}
