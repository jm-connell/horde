import HelpTip from "../../../components/HelpTip";
import { useSettingsPage } from "../context";
import { Section, SettingRow, Toggle } from "../ui";
import { INPUT_COMPACT, SUMMARY_LENGTH_OPTIONS, SUMMARY_LENGTH_TIP } from "../constants";

export default function FeaturesPane() {
  const { q, match, aiDraft, setAiDraft, saveAi } = useSettingsPage();

  return (
    <Section
      first
      title="Features"
      description="Toggle individual AI jobs."
      hidden={
        !match(
          "features",
          "subtitles",
          "enrich tags",
          "duplicate",
          "category",
          "strictness",
          "summary",
          "summarize",
          "captions",
          "short",
          "medium",
          "long",
          "length"
        )
      }
    >
      <div className="space-y-3">
        <SettingRow
          title="Use subtitles in search indexes"
          description="Include caption text to improve semantic search, related videos, and category matching."
          hidden={!!q && !match("subtitles", "embeddings", "search indexes")}
          control={
            <Toggle
              checked={aiDraft.use_subtitles}
              onChange={() =>
                saveAi({ use_subtitles: !aiDraft.use_subtitles })
              }
            />
          }
        />
        <SettingRow
          title="AI video summaries"
          description="Generated after download when captions are available. Uses OpenRouter when connected; otherwise Ollama (recommend ≥6GB VRAM). Regenerate anytime on Watch."
          hidden={
            !!q &&
            !match("summary", "summarize", "captions", "watch")
          }
          control={
            <Toggle
              checked={aiDraft.ai_summaries}
              onChange={() =>
                saveAi({ ai_summaries: !aiDraft.ai_summaries })
              }
            />
          }
        />
        <SettingRow
          title="AI video chat"
          description="Ask the video questions on the Watch page using its metadata, description, and captions. Larger GPUs auto-upgrade to bigger chat models."
          hidden={
            !!q &&
            !match("chat", "ask", "conversation", "watch", "captions")
          }
          control={
            <Toggle
              checked={aiDraft.ai_chat}
              onChange={() => saveAi({ ai_chat: !aiDraft.ai_chat })}
            />
          }
        />
        {aiDraft.ai_summaries && (
          <SettingRow
            title="Summary length"
            description="Short ≈75–120 words, medium ≈200–280, long ≈300–400. Regenerate after changing."
            hidden={
              !!q &&
              !match(
                "summary",
                "summarize",
                "length",
                "short",
                "medium",
                "long"
              )
            }
            control={
              <div className="flex items-center gap-2">
                <HelpTip text={SUMMARY_LENGTH_TIP} />
                <div className="ui-panel flex rounded-lg border border-ink-700 bg-ink-900 p-0.5">
                  {SUMMARY_LENGTH_OPTIONS.map((opt) => {
                    const selected =
                      aiDraft.summary_length === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          void saveAi({ summary_length: opt.value })
                        }
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
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
            }
          />
        )}
        <SettingRow
          title="Category match strictness"
          description="Minimum similarity for videos under a category chip. Higher = fewer, tighter matches; lower = fuller, noisier shelves."
          hidden={
            !!q &&
            !match(
              "category",
              "categories",
              "strictness",
              "match",
              "score"
            )
          }
          control={
            <input
              type="number"
              min={0.2}
              max={0.9}
              step={0.05}
              aria-label="Category match strictness"
              value={aiDraft.category_min_score}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (Number.isNaN(n)) return;
                setAiDraft((d) => ({
                  ...d,
                  category_min_score: n,
                }));
              }}
              onBlur={(e) => {
                const n = parseFloat(e.target.value);
                const clamped = Math.min(
                  0.9,
                  Math.max(0.2, Number.isNaN(n) ? 0.55 : n)
                );
                const rounded = Math.round(clamped * 100) / 100;
                void saveAi({ category_min_score: rounded });
              }}
              className={INPUT_COMPACT}
            />
          }
        />
        <SettingRow
          title="Enrich tags with LLM"
          description="Suggest tags from title, channel, and description after download (subtitles optional). Skipped if you edit tags manually. Summaries still require captions."
          hidden={!!q && !match("enrich tags", "llm")}
          control={
            <Toggle
              checked={aiDraft.enrich_tags}
              onChange={() =>
                saveAi({ enrich_tags: !aiDraft.enrich_tags })
              }
            />
          }
        />
        {aiDraft.enrich_tags && (
          <SettingRow
            title="Re-check tags after"
            description="Unlocked videos whose tags haven’t been reviewed in this many days get another pass during Enrich missing tags / scheduled sweeps."
            hidden={!!q && !match("re-check tags", "rescan", "tag days")}
            control={
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={7}
                  max={365}
                  step={1}
                  value={aiDraft.tag_rescan_days}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setAiDraft((d) => ({
                      ...d,
                      tag_rescan_days: Math.max(7, Math.min(365, Math.round(n))),
                    }));
                  }}
                  onBlur={() => {
                    const days = Math.max(
                      7,
                      Math.min(365, Math.round(aiDraft.tag_rescan_days || 90))
                    );
                    void saveAi({ tag_rescan_days: days });
                  }}
                  className={INPUT_COMPACT}
                />
                <span className="text-xs text-gray-500">days</span>
              </div>
            }
          />
        )}
        <SettingRow
          title="AI duplicate confirmation"
          description="Score heuristic duplicate groups in Import."
          hidden={!!q && !match("duplicate", "confirmation")}
          control={
            <Toggle
              checked={aiDraft.ai_duplicates}
              onChange={() =>
                saveAi({ ai_duplicates: !aiDraft.ai_duplicates })
              }
            />
          }
        />
      </div>
    </Section>
  );
}
