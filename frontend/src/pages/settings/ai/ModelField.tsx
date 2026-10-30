import { useEffect, useState } from "react";
import ThemedSelect from "../../../components/ThemedSelect";
import HelpTip from "../../../components/HelpTip";
import type { OpenRouterModel } from "../../../types";
import { INPUT, PANEL_BTN } from "../constants";
import { openRouterSelectOptions } from "../openRouterModels";

/**
 * A model id: a searchable list when the endpoint lists its models (OpenRouter
 * rows show prices), otherwise, or on request, a text box.
 */
export default function ModelField({
  label,
  tip,
  value,
  models,
  pinRecommended = false,
  placeholder,
  onSave,
  emptyOption,
}: {
  label: string;
  tip: string;
  value: string;
  models: OpenRouterModel[];
  pinRecommended?: boolean;
  placeholder: string;
  onSave: (value: string) => void;
  /** Offered first in the list for an empty value (e.g. "Same as …"). */
  emptyOption?: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const listed = models.length > 0 && !typing;

  return (
    <div className="max-w-xl space-y-1.5">
      <span className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
        {label}
        <HelpTip text={tip} />
      </span>
      {listed ? (
        <ThemedSelect
          value={value}
          aria-label={label}
          className="w-full max-w-xl"
          buttonClassName="w-full"
          listClassName="max-h-80"
          searchable
          searchPlaceholder="Search models…"
          options={[
            ...(emptyOption ? [{ value: "", label: emptyOption }] : []),
            ...openRouterSelectOptions(models, value, "", {
              pinRecommended,
            }),
          ]}
          onChange={(next) => onSave(next)}
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() !== value) onSave(draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder={placeholder}
          aria-label={label}
          className={INPUT}
        />
      )}
      {models.length > 0 && (
        <button
          type="button"
          className={`${PANEL_BTN} text-xs`}
          onClick={() => setTyping((t) => !t)}
        >
          {typing ? "Pick from the list" : "Type a model name"}
        </button>
      )}
    </div>
  );
}
