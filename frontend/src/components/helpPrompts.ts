import type { HelpAssistantInfo, Permission } from "../types";

/** Always offered first; answered here, without asking the model. */
export const WHAT_CAN_YOU_DO = "What can you do?";

type Area = "help" | "settings" | "data" | "actions" | "css";

interface SamplePrompt {
  text: string;
  area: Area;
  /** Shown only to administrators. */
  admin?: boolean;
  /** Shown only with this permission. */
  needs?: Permission;
}

/** Questions that show off one ability each; three are shown per opening. */
export const SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    text: "How do I download a whole playlist?",
    area: "help",
    needs: "download",
  },
  { text: "Why would a download fail?", area: "help" },
  { text: "How does Recommended+ pick videos?", area: "help" },
  { text: "How do I watch videos offline?", area: "help" },
  {
    text: "How do I import videos I already have?",
    area: "help",
    needs: "download",
  },
  { text: "Where are my videos stored on disk?", area: "help", admin: true },
  { text: "How do I add another account?", area: "help", admin: true },
  { text: "How do I set up AI features?", area: "help", admin: true },
  { text: "How do I update Horde?", area: "help", admin: true },
  { text: "Turn on the rain background", area: "settings" },
  { text: "Make the text bigger", area: "settings" },
  { text: "Switch to the OLED theme", area: "settings" },
  { text: "Where do I change the subtitle size?", area: "settings" },
  { text: "Skip sponsor segments automatically", area: "settings" },
  { text: "Make panels less see-through", area: "settings" },
  { text: "Start videos at 1.5× speed", area: "settings" },
  { text: "Where is the background animation setting?", area: "settings" },
  { text: "Turn off thumbnail previews on hover", area: "settings" },
  { text: "Why did my last download fail?", area: "data", needs: "download" },
  { text: "What have I watched recently?", area: "data" },
  { text: "What should I watch next?", area: "data" },
  {
    text: "Which channels take up the most space in my library?",
    area: "data",
  },
  { text: "Find something about space in my library", area: "data" },
  { text: "What's in my playlists?", area: "data" },
  {
    text: "Make a playlist of my unwatched recent downloads",
    area: "actions",
  },
  {
    text: "Can you download a video for me?",
    area: "actions",
    needs: "download",
  },
  { text: "Make the video cards rounder with CSS", area: "css" },
  { text: "Write CSS to give the top bar a frosted look", area: "css" },
  { text: "Use CSS to make the accent glow on hover", area: "css" },
  { text: "Is everything healthy on this server?", area: "help", admin: true },
];

/**
 * "What can you do?" plus two more from different areas, chosen at random
 * each time the panel opens, from the prompts this person can use.
 */
export function pickPrompts(
  allowed: (p: SamplePrompt) => boolean,
  random: () => number = Math.random
): string[] {
  const pool = SAMPLE_PROMPTS.filter(allowed);
  const picked: SamplePrompt[] = [];
  while (picked.length < 2 && pool.length) {
    const fresh = pool.filter((p) => !picked.some((q) => q.area === p.area));
    const from = fresh.length ? fresh : pool;
    const choice = from[Math.floor(random() * from.length)];
    picked.push(choice);
    pool.splice(pool.indexOf(choice), 1);
  }
  return [WHAT_CAN_YOU_DO, ...picked.map((p) => p.text)];
}

export function promptAllowed(
  p: SamplePrompt,
  who: { isAdmin: boolean; can: (permission: Permission) => boolean }
): boolean {
  if (p.admin && !who.isAdmin) return false;
  return !p.needs || who.can(p.needs);
}

/** The answer to "What can you do?", written as a reply with links. */
export function capabilitiesAnswer(opts: {
  info: HelpAssistantInfo | undefined;
  isAdmin: boolean;
  canDownload: boolean;
}): string {
  const { info, isAdmin, canDownload } = opts;
  const lines = [
    "Here's what I can do:",
    "",
    "- **Answer questions** about using, setting up and fixing Horde, from this server's own docs. Try “Why would a download fail?”",
    "- **Take you to any setting** and highlight it, like [[setting:background-effect]].",
    "- **Change settings for you**: ask “Make the text bigger” and you get an Apply button (with Undo). Riskier ones, like AI keys, accounts and storage, I only link to.",
    "- **Look at your own data** when you turn on [[setting:help-data]] in Settings: downloads, library, history and playlists. Try “Why did my last download fail?” or “What should I watch next?”",
    canDownload
      ? "- **Download links and build playlists**: send me a link, or ask for a playlist of videos I found. You confirm each one."
      : "- **Build playlists** from videos I find for you. You confirm each one.",
    "- **Write custom CSS** to restyle Horde, with a preview you keep or revert. If a stylesheet ever hides the page, open Horde in a browser tab with `?nocss` on the address.",
    "",
    "Nothing changes until you press a button.",
  ];
  if (info?.available) {
    const name =
      isAdmin && info.model
        ? `\`${info.model}\``
        : "a model the administrator chose";
    if (info.tier === "small") {
      lines.push(
        "",
        `I'm running on ${name}, a small model: answers and links work, but my CSS can be rough. ` +
          (isAdmin
            ? "A stronger Assistant model in [[setting:ai-models]] helps."
            : "The administrator can give me a stronger model.")
      );
    } else if (isAdmin && info.model) {
      lines.push("", `I'm running on ${name}.`);
    }
  }
  return lines.join("\n");
}
