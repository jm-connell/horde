/**
 * Recognising an AI provider from what the user pastes: an API key with a
 * known prefix stands for its provider's URL; anything else is a server URL.
 * Any OpenAI-compatible URL works; the names here only label it and suggest
 * starting models.
 */
export type AiProvider = {
  label: string;
  url: string;
  /** Suggested while no model is set. */
  chat?: string;
  embed?: string;
  /** Has no /embeddings: search needs a second server. */
  noEmbeddings?: boolean;
};

/**
 * Providers whose keys say who issued them. OpenAI's are matched narrowly:
 * DeepSeek, Anthropic and others also hand out plain `sk-` keys, and a key
 * must never be sent to a provider that did not issue it.
 */
const KEY_PROVIDERS: (AiProvider & { isKey: (key: string) => boolean })[] = [
  {
    label: "OpenRouter",
    isKey: (k) => k.startsWith("sk-or-"),
    url: "https://openrouter.ai/api/v1",
    chat: "google/gemini-2.5-flash-lite",
    embed: "openai/text-embedding-3-small",
  },
  {
    label: "Google Gemini",
    isKey: (k) => k.startsWith("AIza"),
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    chat: "gemini-2.5-flash-lite",
    embed: "gemini-embedding-001",
  },
  {
    label: "Groq",
    isKey: (k) => k.startsWith("gsk_"),
    url: "https://api.groq.com/openai/v1",
    chat: "llama-3.1-8b-instant",
    noEmbeddings: true,
  },
  {
    label: "OpenAI",
    // Project, service-account and admin keys, and legacy keys, which embed
    // "T3BlbkFJ" ("OpenAI" in base64).
    isKey: (k) =>
      /^sk-(proj|svcacct|admin)-/.test(k) ||
      (k.startsWith("sk-") && k.includes("T3BlbkFJ")),
    url: "https://api.openai.com/v1",
    chat: "gpt-4.1-mini",
    embed: "text-embedding-3-small",
  },
];

/** Known by their URL only: their keys have no telling prefix. */
const URL_PROVIDERS: AiProvider[] = [
  {
    label: "Mistral",
    url: "https://api.mistral.ai/v1",
    chat: "mistral-small-latest",
    embed: "mistral-embed",
  },
  {
    label: "DeepSeek",
    url: "https://api.deepseek.com/v1",
    chat: "deepseek-chat",
    noEmbeddings: true,
  },
  { label: "Together AI", url: "https://api.together.xyz/v1" },
];

const OLLAMA: AiProvider = {
  label: "Ollama",
  url: "",
  chat: "llama3.2:3b",
  embed: "nomic-embed-text",
};

export type EndpointInput =
  | { url: string; key: string | null; provider?: AiProvider }
  | { error: string };

/** Ollama's port: the likeliest server behind an address typed without one. */
const DEFAULT_PORT = "11434";

/** A host name or IP, optionally with a port and path (no scheme). */
const BARE_ADDRESS = /^[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/;

/** The provider that issued ``key``, if Horde can tell. */
export function keyProvider(key: string): AiProvider | undefined {
  const value = key.trim();
  return KEY_PROVIDERS.find((p) => p.isKey(value));
}

/** A pasted API key or server URL, as the URL (and key) to connect to. */
export function readEndpointInput(text: string): EndpointInput {
  const value = text.trim();
  if (!value) return { error: "Paste an API key or a server URL." };
  const provider = keyProvider(value);
  if (provider) return { url: provider.url, key: value, provider };
  if (/^https?:\/\//i.test(value)) return { url: value, key: null };
  // A bare address has a dot, a port or a path, or is a short host name like
  // `ollama`; anything else is most likely a key, which must not be sent
  // anywhere as a host name.
  if (BARE_ADDRESS.test(value) && (/[.:/]/.test(value) || value.length < 20)) {
    const [hostPort, ...path] = value.split("/");
    const port = hostPort.includes(":") ? "" : `:${DEFAULT_PORT}`;
    return {
      url: `http://${hostPort}${port}${path.length ? `/${path.join("/")}` : ""}`,
      key: null,
    };
  }
  return {
    error:
      "Horde can't tell which provider this key is for. Paste the provider's API URL here and the key in the key field.",
  };
}

function hostAndPort(url: string): { host: string; port: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return { host: "", port: "" };
  }
}

/**
 * The provider behind ``url``: a known cloud host, or Ollama when the
 * connection test (``kind``) or its usual port says so.
 */
export function providerFor(
  url: string,
  kind?: string | null
): AiProvider | undefined {
  const { host, port } = hostAndPort(url);
  if (!host) return undefined;
  const known = [...KEY_PROVIDERS, ...URL_PROVIDERS].find(
    (p) => hostAndPort(p.url).host === host
  );
  if (known) return known;
  if (kind === "ollama" || port === "11434") return OLLAMA;
  return undefined;
}

/** "OpenRouter", "Ollama", … or a generic name for any other server. */
export function providerLabel(url: string, kind?: string | null): string {
  if (!url.trim()) return "";
  return providerFor(url, kind)?.label ?? "OpenAI-compatible server";
}

/** The pasted key's provider, while the input is still being typed. */
export function keyProviderLabel(text: string): string {
  return keyProvider(text)?.label ?? "";
}

/**
 * Why ``key`` must not go to ``url``: it is a key Horde recognises, issued
 * for another host. Empty when it may.
 */
export function keyMismatch(url: string, key: string): string {
  const issuer = keyProvider(key);
  if (!issuer || hostAndPort(issuer.url).host === hostAndPort(url).host)
    return "";
  return `That key is for ${issuer.label}: paste it in the first field on its own.`;
}

export const COMPATIBLE_PROVIDERS_TIP =
  "Any service with an OpenAI-compatible API works. Paste just the key for OpenRouter, OpenAI, Google Gemini or Groq. For others (Mistral, DeepSeek, Together, …) paste the provider's API URL, then the key. For a server you run (Ollama, LM Studio, llama.cpp, vLLM) paste its address, e.g. 192.168.1.50:1234; without a port, Ollama's 11434 is used.";
