import { createContext, useContext } from "react";

interface Slots {
  /** Where the active body puts its title (one body open) ... */
  title: HTMLElement | null;
  /** ... a control beside the title (or the tabs) ... */
  addon: HTMLElement | null;
  /** ... and its own header buttons. */
  actions: HTMLElement | null;
  /** Phone layout: the frame is a bottom sheet. */
  isMobile: boolean;
}

export const SlotCtx = createContext<Slots>({
  title: null,
  addon: null,
  actions: null,
  isMobile: false,
});
/** Whether the body reading it is the one showing. */
export const ActiveCtx = createContext(true);

/** Whether this body is the one showing, and whether the frame is a phone sheet. */
export function usePanelFrame(): { active: boolean; isMobile: boolean } {
  return {
    active: useContext(ActiveCtx),
    isMobile: useContext(SlotCtx).isMobile,
  };
}
