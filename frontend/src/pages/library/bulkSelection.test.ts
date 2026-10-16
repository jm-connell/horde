import { describe, expect, it } from "vitest";
import {
  bulkSelectionReducer,
  initialBulkSelection,
  type BulkSelectionAction,
  type BulkSelectionState,
} from "./bulkSelection";

const ids = [10, 11, 12, 13, 14];

function run(...actions: BulkSelectionAction[]): BulkSelectionState {
  return actions.reduce(bulkSelectionReducer, initialBulkSelection);
}

const click = (index: number, shift = false): BulkSelectionAction => ({
  type: "toggle",
  id: ids[index],
  index,
  shift,
  orderedIds: ids,
});

describe("bulkSelectionReducer", () => {
  it("starts out of select mode with nothing selected", () => {
    expect(initialBulkSelection.mode).toBe(false);
    expect(initialBulkSelection.selected.size).toBe(0);
  });

  it("enters select mode without clearing a selection", () => {
    const state = run({ type: "enter" }, click(1), { type: "enter" });
    expect(state.mode).toBe(true);
    expect([...state.selected]).toEqual([11]);
  });

  it("toggles a card on and off", () => {
    expect([...run(click(2)).selected]).toEqual([12]);
    expect(run(click(2), click(2)).selected.size).toBe(0);
  });

  it("selects the range between the last click and a shift-click", () => {
    const state = run(click(1), click(3, true));
    expect([...state.selected].sort()).toEqual([11, 12, 13]);
    expect(state.anchor).toBe(3);
  });

  it("selects a range upward too, and extends from the new anchor", () => {
    const state = run(click(3), click(1, true), click(0, true));
    expect([...state.selected].sort()).toEqual([10, 11, 12, 13]);
  });

  it("treats shift-click as a plain toggle when there is no anchor", () => {
    expect([...run(click(2, true)).selected]).toEqual([12]);
  });

  it("keeps cards already selected when a range is added", () => {
    const state = run(click(4), click(0), click(2, true));
    expect([...state.selected].sort()).toEqual([10, 11, 12, 14]);
  });

  it("ignores range positions past the end of a list that shrank", () => {
    const state = run(click(4), {
      type: "toggle",
      id: 10,
      index: 0,
      shift: true,
      orderedIds: [10, 11],
    });
    expect([...state.selected].sort()).toEqual([10, 11, 14]);
  });

  it("does not change the previous state object", () => {
    const before = run(click(1));
    run(click(1), click(2));
    expect([...before.selected]).toEqual([11]);
  });

  it("leaves select mode and forgets the selection and anchor", () => {
    const state = run({ type: "enter" }, click(1), { type: "exit" });
    expect(state).toEqual(initialBulkSelection);
  });
});
