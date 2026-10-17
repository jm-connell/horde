const PLAYER_CHROME_BTN =
  "ui-player-chrome rounded px-1.5 py-1 text-xs font-medium text-gray-200 hover:text-accent";
const PLAYER_CHROME_BTN_ACTIVE =
  "ui-player-chrome rounded px-1.5 py-1 text-xs font-medium text-accent";
const PLAYER_MENU_ITEM =
  "rounded px-2 py-1.5 text-[11px] font-medium text-gray-200 hover:bg-ink-700/50 hover:text-accent";
const PLAYER_MENU_ITEM_ACTIVE =
  "rounded px-2 py-1.5 text-[11px] font-medium text-accent";

export function playerChromeBtn(active: boolean): string {
  return active ? PLAYER_CHROME_BTN_ACTIVE : PLAYER_CHROME_BTN;
}

export function playerMenuItem(active: boolean): string {
  return active ? PLAYER_MENU_ITEM_ACTIVE : PLAYER_MENU_ITEM;
}
