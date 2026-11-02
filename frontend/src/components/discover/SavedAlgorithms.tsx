import { useId, useState } from "react";
import { ApiError } from "../../api";
import { useToast } from "../../context/ToastContext";
import {
  useDeleteRecAlgorithm,
  useRecAlgorithms,
  useSaveRecAlgorithm,
  useUpdateRecAlgorithm,
} from "../../queries/discover";
import type { RecTuning, RecTuningState } from "../../types";
import { button } from "../buttons";
import ConfirmDialog from "../ConfirmDialog";

const CHIP =
  "ui-interactive max-w-full truncate rounded-full border px-3 py-1 text-xs font-medium transition-colors";
const CHIP_IDLE = `${CHIP} border-ink-700 text-gray-300 hover:border-accent hover:text-accent`;
const CHIP_ON = `${CHIP} border-accent/50 bg-accent/15 text-accent`;

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

/**
 * Saved algorithms in the picker (yours, then those others share), Save as
 * (with sharing), Save back to the one your own values came from, and sharing
 * or deleting the one in use when it is yours.
 */
export default function SavedAlgorithms({
  state,
  active,
  values,
  onPick,
  beforeSave,
  afterSave,
}: {
  state: RecTuningState;
  /** What is picked now ("custom" while a move is waiting to be saved). */
  active: string;
  /** The values on screen (saved or not). */
  values: RecTuning;
  onPick: (id: string) => void;
  /** A save of these values starts: no debounced save of them after it. */
  beforeSave: () => void;
  /** It succeeded: nothing of these values is waiting any more. */
  afterSave: () => void;
}) {
  const { showToast, showError } = useToast();
  const list = useRecAlgorithms().data?.items ?? [];
  const create = useSaveRecAlgorithm();
  const update = useUpdateRecAlgorithm();
  const remove = useDeleteRecAlgorithm();
  const nameId = useId();
  const shareId = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const current = state.algorithm;
  const own = current?.mine ? current : null;

  const saveAs = () => {
    if (!name.trim()) return;
    beforeSave();
    create.mutate(
      { name: name.trim(), shared: share, values },
      {
        onSuccess: (algo) => {
          afterSave();
          setNaming(false);
          setName("");
          setShare(false);
          showToast(
            algo.shared
              ? `Saved “${algo.name}” and shared it`
              : `Saved “${algo.name}”`
          );
        },
        onError: (err) => showError(errorText(err, "Could not save that")),
      }
    );
  };

  const saveBack = () => {
    const target = state.based_on;
    if (!target) return;
    beforeSave();
    update.mutate(
      { id: target.id, payload: { values } },
      {
        onSuccess: () => {
          afterSave();
          showToast(`Saved to “${target.name}”`);
        },
        onError: (err) => showError(errorText(err, "Could not save that")),
      }
    );
  };

  return (
    <div className="space-y-2" data-horde="saved-algorithms">
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Saved algorithms">
          {list.map((a) => {
            const id = `algo:${a.id}`;
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={active === id}
                onClick={() => onPick(id)}
                title={
                  a.mine
                    ? a.shared
                      ? "Yours, shared with other accounts"
                      : "Yours"
                    : `Shared by ${a.owner}`
                }
                className={active === id ? CHIP_ON : CHIP_IDLE}
              >
                {a.name}
                {!a.mine && (
                  <span className="font-normal text-muted"> · {a.owner}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {current && active === `algo:${current.id}` && (
        <p className="text-xs text-muted">
          {current.mine
            ? current.shared
              ? "Yours, shared with other accounts."
              : "Yours. Moving a setting makes changes you can save back to it."
            : `Shared by ${current.owner}. You get their changes; moving a setting makes your own copy.`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {active === "custom" && state.based_on && (
          <button
            type="button"
            onClick={saveBack}
            disabled={update.isPending}
            className={button("secondary", "xs")}
          >
            Save to “{state.based_on.name}”
          </button>
        )}
        {!naming && (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className={button("quiet", "xs")}
          >
            Save as…
          </button>
        )}
        {own && active === `algo:${own.id}` && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={own.shared}
                onChange={(e) =>
                  update.mutate(
                    { id: own.id, payload: { shared: e.target.checked } },
                    {
                      onError: (err) =>
                        showError(errorText(err, "Could not change that")),
                    }
                  )
                }
                className="accent-[rgb(var(--accent))]"
              />
              Share “{own.name}” with other accounts
            </label>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-muted hover:text-danger"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {naming && (
        <form
          className="space-y-2 rounded-lg border border-ink-700 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveAs();
          }}
        >
          <label htmlFor={nameId} className="block text-xs text-muted">
            Name
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Weeknight"
            // The form opens on request: put the user in the field.
            // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the user's own click on Save as
            autoFocus
            className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-100 outline-hidden placeholder:text-muted focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={shareId}
              type="checkbox"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
              className="accent-[rgb(var(--accent))]"
            />
            <label htmlFor={shareId} className="text-xs text-gray-300">
              Share with other accounts
            </label>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setNaming(false)}
              className={button("quiet", "xs")}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || create.isPending}
              className={button("primary", "xs")}
            >
              Save
            </button>
          </div>
          <p className="text-[11px] text-muted">
            Saves the settings above. Your interests and blocked topics are not
            part of it{share ? ", and are never shared" : ""}.
          </p>
        </form>
      )}

      {confirmDelete && own && (
        <ConfirmDialog
          title={`Delete “${own.name}”?`}
          body={
            own.shared
              ? "Anyone else using it gets a private copy; you keep its settings as your own."
              : "You keep its settings as your own."
          }
          confirmLabel="Delete"
          danger
          busy={remove.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            remove.mutate(own.id, {
              onSuccess: () => setConfirmDelete(false),
              onError: (err) =>
                showError(errorText(err, "Could not delete that")),
            })
          }
        />
      )}
    </div>
  );
}
