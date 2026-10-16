import { useCallback, useMemo, useReducer } from "react";

/** Select mode on the library grid: which cards are ticked, and where a range starts. */
export interface BulkSelectionState {
  mode: boolean;
  selected: ReadonlySet<number>;
  /** Index of the card clicked last; shift-click extends a range from it. */
  anchor: number | null;
}

export type BulkSelectionAction =
  | { type: "enter" }
  | { type: "exit" }
  | {
      type: "toggle";
      id: number;
      index: number;
      shift: boolean;
      /** Video ids in the order the cards are shown, so an index maps to a card. */
      orderedIds: readonly number[];
    };

export const initialBulkSelection: BulkSelectionState = {
  mode: false,
  selected: new Set(),
  anchor: null,
};

export function bulkSelectionReducer(
  state: BulkSelectionState,
  action: BulkSelectionAction
): BulkSelectionState {
  switch (action.type) {
    case "enter":
      return { ...state, mode: true };
    case "exit":
      return initialBulkSelection;
    case "toggle": {
      const next = new Set(state.selected);
      if (action.shift && state.anchor !== null) {
        const lo = Math.min(action.index, state.anchor);
        const hi = Math.max(action.index, state.anchor);
        for (let i = lo; i <= hi; i++) {
          const id = action.orderedIds[i];
          if (id !== undefined) next.add(id);
        }
      } else if (next.has(action.id)) {
        next.delete(action.id);
      } else {
        next.add(action.id);
      }
      return { ...state, selected: next, anchor: action.index };
    }
  }
}

export function useBulkSelection(orderedIds: readonly number[]) {
  const [state, dispatch] = useReducer(
    bulkSelectionReducer,
    initialBulkSelection
  );
  const toggle = useCallback(
    (id: number, index: number, shift: boolean) =>
      dispatch({ type: "toggle", id, index, shift, orderedIds }),
    [orderedIds]
  );
  const enter = useCallback(() => dispatch({ type: "enter" }), []);
  const exit = useCallback(() => dispatch({ type: "exit" }), []);
  return useMemo(
    () => ({
      selectMode: state.mode,
      selectedIds: state.selected,
      toggle,
      enter,
      exit,
    }),
    [state.mode, state.selected, toggle, enter, exit]
  );
}
