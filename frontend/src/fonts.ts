/** UI font presets + custom (Google Fonts URL or local file). */

export type UiFont =
  | "default"
  | "jetbrains-mono"
  | "roboto"
  | "source-code-pro"
  | "ubuntu"
  | "space-grotesk"
  | "ibm-plex-sans"
  | "inconsolata"
  | "custom";

export interface FontPreset {
  value: UiFont;
  label: string;
  /** CSS font-family stack (unused for custom). */
  stack: string;
  /** Google Fonts css2 family param, or null for default (no CDN load). */
  googleFamily: string | null;
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
    value: "custom",
    label: "Custom…",
    stack: "system-ui, sans-serif",
    googleFamily: null,
  },
];

const VALID_UI_FONTS = new Set<string>(FONT_OPTIONS.map((f) => f.value));

const DEFAULT_STACK = FONT_OPTIONS[0].stack;
const LINK_ID = "horde-ui-font";
const PRECONNECT_GOOGLE_ID = "horde-ui-font-preconnect-google";
const PRECONNECT_GSTATIC_ID = "horde-ui-font-preconnect-gstatic";
const CUSTOM_FACE_FAMILY = "HordeCustomFont";
const IDB_NAME = "horde-fonts";
const IDB_STORE = "files";
const IDB_KEY = "custom";

export interface UiFontSettings {
  uiFont: UiFont;
  customFontUrl: string;
  customFontHasFile: boolean;
}

export function normalizeUiFont(value: unknown): UiFont {
  // Inter was removed as a separate preset; map to Default.
  if (value === "inter") return "default";
  if (typeof value === "string" && VALID_UI_FONTS.has(value)) {
    return value as UiFont;
  }
  return "default";
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

  // Full css2 stylesheet URL
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

  // Specimen page: https://fonts.google.com/specimen/Space+Grotesk
  const specimen = input.match(
    /fonts\.google\.com\/specimen\/([^/?#]+)/i
  );
  if (specimen) {
    const name = decodeURIComponent(specimen[1].replace(/\+/g, " "));
    const param = `${name.replace(/ /g, "+")}:wght@400;500;600;700`;
    return { cssUrl: googleCssUrl(param), family: name };
  }

  // Bare family name
  const name = input.replace(/["']/g, "").trim();
  if (!name) return { cssUrl: null, family: null };
  const param = `${name.replace(/ /g, "+")}:wght@400;500;600;700`;
  return { cssUrl: googleCssUrl(param), family: name };
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

let customFace: FontFace | null = null;

async function clearCustomFace(): Promise<void> {
  if (customFace) {
    try {
      document.fonts.delete(customFace);
    } catch {
      /* ignore */
    }
    customFace = null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

interface StoredFont {
  buffer: ArrayBuffer;
  mime: string;
  filename: string;
}

export async function saveCustomFontFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(
      { buffer, mime: file.type || "font/woff2", filename: file.name } satisfies StoredFont,
      IDB_KEY
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Font save failed"));
  });
  db.close();
}

export async function clearCustomFontFile(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Font delete failed"));
    });
    db.close();
  } catch {
    /* ignore */
  }
  await clearCustomFace();
}

async function loadCustomFontFile(): Promise<StoredFont | null> {
  try {
    const db = await openDb();
    const stored = await new Promise<StoredFont | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as StoredFont) ?? null);
      req.onerror = () => reject(req.error ?? new Error("Font read failed"));
    });
    db.close();
    return stored;
  } catch {
    return null;
  }
}

async function registerCustomFontFile(): Promise<boolean> {
  await clearCustomFace();
  const stored = await loadCustomFontFile();
  if (!stored?.buffer) return false;
  const face = new FontFace(CUSTOM_FACE_FAMILY, stored.buffer);
  await face.load();
  document.fonts.add(face);
  customFace = face;
  return true;
}

export async function applyUiFont(settings: UiFontSettings): Promise<void> {
  const preset = FONT_OPTIONS.find((f) => f.value === settings.uiFont);

  if (!preset || preset.value === "default") {
    setStylesheetHref(null);
    await clearCustomFace();
    setFontStack(DEFAULT_STACK);
    return;
  }

  if (preset.value !== "custom") {
    await clearCustomFace();
    if (preset.googleFamily) {
      setStylesheetHref(googleCssUrl(preset.googleFamily));
    } else {
      setStylesheetHref(null);
    }
    setFontStack(preset.stack);
    return;
  }

  // Custom: prefer uploaded file, else Google Fonts URL / family name
  if (settings.customFontHasFile) {
    const ok = await registerCustomFontFile();
    if (ok) {
      setStylesheetHref(null);
      setFontStack(`"${CUSTOM_FACE_FAMILY}", system-ui, sans-serif`);
      return;
    }
  }

  await clearCustomFace();
  const parsed = parseCustomFontInput(settings.customFontUrl);
  if (parsed.cssUrl && parsed.family) {
    setStylesheetHref(parsed.cssUrl);
    setFontStack(`"${parsed.family}", system-ui, sans-serif`);
    return;
  }

  setStylesheetHref(null);
  setFontStack(DEFAULT_STACK);
}
