/** UI font presets + permanently saved custom fonts (URL or server file). */

export type BuiltinFontId =
  | "default"
  | "jetbrains-mono"
  | "roboto"
  | "source-code-pro"
  | "ubuntu"
  | "space-grotesk"
  | "ibm-plex-sans"
  | "inconsolata"
  | "oxanium"
  | "source-sans-3"
  | "electrolize"
  | "custom";

/** Builtin id, saved custom id, or the "Add custom…" sentinel. */
export type UiFont = string;

export interface FontPreset {
  value: BuiltinFontId;
  label: string;
  stack: string;
  googleFamily: string | null;
}

export interface SavedCustomFont {
  id: string;
  name: string;
  source: "url" | "file";
  /** Google Fonts CSS URL / specimen / family name when source is url. */
  url?: string;
}

export const FONT_OPTIONS: FontPreset[] = [
  {
    value: "default",
    label: "Inter (default)",
    stack: "Inter, system-ui, sans-serif",
    googleFamily: null,
  },
  {
    value: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, monospace',
    googleFamily: "JetBrains+Mono:wght@400;500;600;700",
  },
  {
    value: "roboto",
    label: "Roboto",
    stack: '"Roboto", system-ui, sans-serif',
    googleFamily: "Roboto:wght@400;500;700",
  },
  {
    value: "source-code-pro",
    label: "Source Code Pro",
    stack: '"Source Code Pro", ui-monospace, monospace',
    googleFamily: "Source+Code+Pro:wght@400;500;600;700",
  },
  {
    value: "ubuntu",
    label: "Ubuntu",
    stack: '"Ubuntu", system-ui, sans-serif',
    googleFamily: "Ubuntu:wght@400;500;700",
  },
  {
    value: "space-grotesk",
    label: "Space Grotesk",
    stack: '"Space Grotesk", system-ui, sans-serif',
    googleFamily: "Space+Grotesk:wght@400;500;600;700",
  },
  {
    value: "ibm-plex-sans",
    label: "IBM Plex Sans",
    stack: '"IBM Plex Sans", system-ui, sans-serif',
    googleFamily: "IBM+Plex+Sans:wght@400;500;600;700",
  },
  {
    value: "inconsolata",
    label: "Inconsolata",
    stack: '"Inconsolata", ui-monospace, monospace',
    googleFamily: "Inconsolata:wght@400;500;600;700",
  },
  {
    value: "oxanium",
    label: "Oxanium",
    stack: '"Oxanium", system-ui, sans-serif',
    googleFamily: "Oxanium:wght@400;500;600;700",
  },
  {
    value: "source-sans-3",
    label: "Source Sans 3",
    stack: '"Source Sans 3", system-ui, sans-serif',
    googleFamily: "Source+Sans+3:wght@400;500;600;700",
  },
  {
    value: "electrolize",
    label: "Electrolize",
    stack: '"Electrolize", system-ui, sans-serif',
    googleFamily: "Electrolize",
  },
  {
    value: "custom",
    label: "Add custom…",
    stack: "system-ui, sans-serif",
    googleFamily: null,
  },
];

const BUILTIN_IDS = new Set<string>(FONT_OPTIONS.map((f) => f.value));
const DEFAULT_STACK = FONT_OPTIONS[0].stack;
const LINK_ID = "horde-ui-font";
const PRECONNECT_GOOGLE_ID = "horde-ui-font-preconnect-google";
const PRECONNECT_GSTATIC_ID = "horde-ui-font-preconnect-gstatic";

export interface UiFontSettings {
  uiFont: UiFont;
  customFonts: SavedCustomFont[];
}

export function newCustomFontId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `cf_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `cf_${Date.now().toString(36)}`;
}

export function normalizeCustomFonts(value: unknown): SavedCustomFont[] {
  if (!Array.isArray(value)) return [];
  const out: SavedCustomFont[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<SavedCustomFont>;
    if (typeof r.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(r.id)) continue;
    if (BUILTIN_IDS.has(r.id)) continue;
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    if (r.source !== "url" && r.source !== "file") continue;
    out.push({
      id: r.id,
      name: r.name.trim().slice(0, 64),
      source: r.source,
      url: typeof r.url === "string" ? r.url : undefined,
    });
  }
  return out.slice(0, 40);
}

export function normalizeUiFont(
  value: unknown,
  customFonts: SavedCustomFont[] = []
): UiFont {
  if (value === "inter") return "default";
  if (typeof value !== "string" || !value) return "default";
  if (BUILTIN_IDS.has(value)) return value;
  if (customFonts.some((f) => f.id === value)) return value;
  return "default";
}

/** Builtin presets + saved customs + Add custom… */
export function fontSelectOptions(
  customFonts: SavedCustomFont[]
): { value: string; label: string }[] {
  const builtins = FONT_OPTIONS.filter((f) => f.value !== "custom").map(
    (f) => ({ value: f.value, label: f.label })
  );
  const saved = customFonts.map((f) => ({
    value: f.id,
    label: f.name,
  }));
  return [
    ...builtins,
    ...saved,
    { value: "custom", label: "Add custom…" },
  ];
}

function googleCssUrl(familyParam: string): string {
  return `https://fonts.googleapis.com/css2?family=${familyParam}&display=swap`;
}

/** Extract a CSS family name from a Google Fonts URL or free-text name. */
export function parseCustomFontInput(raw: string): {
  cssUrl: string | null;
  family: string | null;
} {
  const input = raw.trim();
  if (!input) return { cssUrl: null, family: null };

  if (/fonts\.googleapis\.com\/css2?/i.test(input)) {
    try {
      const url = new URL(input);
      const familyParam = url.searchParams.get("family");
      if (familyParam) {
        const name = familyParam.split(":")[0].replace(/\+/g, " ").trim();
        return { cssUrl: input, family: name || null };
      }
    } catch {
      /* fall through */
    }
    return { cssUrl: input, family: null };
  }

  const specimen = input.match(
    /fonts\.google\.com\/specimen\/([^/?#]+)/i
  );
  if (specimen) {
    const name = decodeURIComponent(specimen[1].replace(/\+/g, " "));
    const param = `${name.replace(/ /g, "+")}:wght@400;500;600;700`;
    return { cssUrl: googleCssUrl(param), family: name };
  }

  const name = input.replace(/["']/g, "").trim();
  if (!name) return { cssUrl: null, family: null };
  const param = `${name.replace(/ /g, "+")}:wght@400;500;600;700`;
  return { cssUrl: googleCssUrl(param), family: name };
}

function faceFamilyForId(id: string): string {
  return `HordeFont_${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function ensurePreconnects(): void {
  const head = document.head;
  if (!document.getElementById(PRECONNECT_GOOGLE_ID)) {
    const a = document.createElement("link");
    a.id = PRECONNECT_GOOGLE_ID;
    a.rel = "preconnect";
    a.href = "https://fonts.googleapis.com";
    head.appendChild(a);
  }
  if (!document.getElementById(PRECONNECT_GSTATIC_ID)) {
    const b = document.createElement("link");
    b.id = PRECONNECT_GSTATIC_ID;
    b.rel = "preconnect";
    b.href = "https://fonts.gstatic.com";
    b.crossOrigin = "anonymous";
    head.appendChild(b);
  }
}

function setStylesheetHref(href: string | null): void {
  const existing = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!href) {
    existing?.remove();
    document.getElementById(PRECONNECT_GOOGLE_ID)?.remove();
    document.getElementById(PRECONNECT_GSTATIC_ID)?.remove();
    return;
  }
  ensurePreconnects();
  let link = existing;
  if (!link) {
    link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

function setFontStack(stack: string): void {
  document.documentElement.style.setProperty("--font-sans", stack);
}

const loadedFaces = new Map<string, FontFace>();

async function unloadFace(id: string): Promise<void> {
  const face = loadedFaces.get(id);
  if (!face) return;
  try {
    document.fonts.delete(face);
  } catch {
    /* ignore */
  }
  loadedFaces.delete(id);
}

async function unloadAllFaces(): Promise<void> {
  for (const id of [...loadedFaces.keys()]) {
    await unloadFace(id);
  }
}

async function registerServerFont(id: string): Promise<string | null> {
  if (loadedFaces.has(id)) {
    return faceFamilyForId(id);
  }
  const family = faceFamilyForId(id);
  const face = new FontFace(
    family,
    `url(/api/fonts/${encodeURIComponent(id)})`
  );
  try {
    await face.load();
  } catch {
    return null;
  }
  document.fonts.add(face);
  loadedFaces.set(id, face);
  return family;
}

export async function applyUiFont(settings: UiFontSettings): Promise<void> {
  const { uiFont, customFonts } = settings;

  if (!uiFont || uiFont === "default" || uiFont === "custom") {
    setStylesheetHref(null);
    await unloadAllFaces();
    setFontStack(DEFAULT_STACK);
    return;
  }

  const builtin = FONT_OPTIONS.find((f) => f.value === uiFont);
  if (builtin) {
    await unloadAllFaces();
    if (builtin.googleFamily) {
      setStylesheetHref(googleCssUrl(builtin.googleFamily));
    } else {
      setStylesheetHref(null);
    }
    setFontStack(builtin.stack);
    return;
  }

  const saved = customFonts.find((f) => f.id === uiFont);
  if (!saved) {
    setStylesheetHref(null);
    await unloadAllFaces();
    setFontStack(DEFAULT_STACK);
    return;
  }

  if (saved.source === "file") {
    setStylesheetHref(null);
    const family = await registerServerFont(saved.id);
    if (family) {
      for (const id of [...loadedFaces.keys()]) {
        if (id !== saved.id) await unloadFace(id);
      }
      setFontStack(`"${family}", system-ui, sans-serif`);
      return;
    }
    setFontStack(DEFAULT_STACK);
    return;
  }

  await unloadAllFaces();
  const parsed = parseCustomFontInput(saved.url ?? "");
  if (parsed.cssUrl && parsed.family) {
    setStylesheetHref(parsed.cssUrl);
    setFontStack(`"${parsed.family}", system-ui, sans-serif`);
    return;
  }

  setStylesheetHref(null);
  setFontStack(DEFAULT_STACK);
}

/** Label for a file-based font (strip extension). */
export function labelFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return (base || filename).slice(0, 64);
}
