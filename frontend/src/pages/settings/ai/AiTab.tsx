import type { Dispatch, SetStateAction } from "react";
import type { AiPane } from "../types";
import ProvidersPane from "./ProvidersPane";
import FeaturesPane from "./FeaturesPane";
import JobsPane from "./JobsPane";
import { AiPageContext } from "./aiPageContext";
import { useAiCore } from "./useAiCore";
import { useAiPanes } from "./useAiPanes";

import { setItem } from "../../../storage";
const PANES: { id: AiPane; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "features", label: "Features" },
  { id: "jobs", label: "Jobs" },
];

/** The pane is routing (`?pane=`), so the settings page owns it and passes it in. */
export default function AiTab({
  aiPane,
  setAiPane,
}: {
  aiPane: AiPane;
  setAiPane: Dispatch<SetStateAction<AiPane>>;
}) {
  const core = useAiCore();
  const panes = useAiPanes(core, aiPane, setAiPane);
  return (
    <AiPageContext.Provider value={{ ...core, ...panes }}>
      <div className="mb-4 flex max-w-md rounded-lg border border-ink-700 bg-ink-900 p-0.5">
        {PANES.map((pane) => {
          const active = aiPane === pane.id;
          return (
            <button
              key={pane.id}
              type="button"
              onClick={() => {
                setAiPane(pane.id);
                setItem("horde.aiPane", pane.id);
              }}
              className={
                active
                  ? "flex-1 rounded-md bg-ink-800 px-3 py-1.5 text-sm font-medium text-accent"
                  : "flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-gray-400 hover:text-gray-200"
              }
            >
              {pane.label}
            </button>
          );
        })}
      </div>
      {aiPane === "providers" && <ProvidersPane />}
      {aiPane === "features" && <FeaturesPane />}
      {aiPane === "jobs" && <JobsPane />}
    </AiPageContext.Provider>
  );
}
