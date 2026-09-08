import type { OpenRouterModel } from "../../types";
import { formatOpenRouterPerMillion } from "../../utils";
import { OPENROUTER_RECOMMENDED_MODELS } from "./constants";

export type OpenRouterSelectOption = {
  value: string;
  label: string;
  hint?: string;
  group?: string;
};

export function openRouterPriceHint(
  model?: OpenRouterModel | null
): string | undefined {
  if (!model) return undefined;
  return (
    formatOpenRouterPerMillion(
      model.prompt_per_million,
      model.completion_per_million
    ) || undefined
  );
}

export function openRouterOptionLabel(model: {
  id: string;
  name: string;
}): string {
  return model.name && model.name !== model.id
    ? `${model.name} (${model.id})`
    : model.id;
}

function matchesFilter(
  model: { id: string; name: string },
  query: string
): boolean {
  if (!query) return true;
  return (
    model.id.toLowerCase().includes(query) ||
    model.name.toLowerCase().includes(query)
  );
}

function toOption(
  model: OpenRouterModel,
  group?: string
): OpenRouterSelectOption {
  return {
    value: model.id,
    label: openRouterOptionLabel(model),
    hint: openRouterPriceHint(model),
    group,
  };
}

function stubModel(id: string): OpenRouterModel {
  return { id, name: id };
}

export function openRouterSelectOptions(
  models: OpenRouterModel[],
  selectedId: string,
  filter = "",
  { pinRecommended = false }: { pinRecommended?: boolean } = {}
): OpenRouterSelectOption[] {
  const query = filter.trim().toLowerCase();
  const byId = new Map(models.map((m) => [m.id, m]));
  const catalogReady = models.length > 0;

  const recommended: OpenRouterModel[] = [];
  if (pinRecommended) {
    for (const id of OPENROUTER_RECOMMENDED_MODELS) {
      const row = byId.get(id);
      if (row) {
        if (matchesFilter(row, query)) recommended.push(row);
        continue;
      }
      if (!catalogReady) {
        const stub = stubModel(id);
        if (matchesFilter(stub, query)) recommended.push(stub);
      }
    }
  }

  const pinnedIds = new Set(recommended.map((m) => m.id));
  const rest = (
    catalogReady
      ? models
      : selectedId
        ? [byId.get(selectedId) ?? stubModel(selectedId)]
        : []
  ).filter((m) => !pinnedIds.has(m.id) && matchesFilter(m, query));

  const opts = [
    ...recommended.map((m) =>
      toOption(m, recommended.length ? "Recommended" : undefined)
    ),
    ...rest.map((m) =>
      toOption(m, recommended.length && rest.length ? "All models" : undefined)
    ),
  ];

  if (selectedId && !opts.some((o) => o.value === selectedId)) {
    const known = byId.get(selectedId) ?? stubModel(selectedId);
    opts.unshift(toOption(known));
  }
  return opts;
}
