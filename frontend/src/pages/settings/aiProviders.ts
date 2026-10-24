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

/** Checked in order, so `sk-or-` comes before OpenAI's plain `sk-`. */
const KEY_PROVIDERS: (AiProvider & { keyPrefix: string })[] = [
  {
    label: "OpenRouter",
    keyPrefix: "sk-or-",
    url: "https://openrouter.ai/api/v1",
    chat: "google/gemini-2.5-flash-lite",
    embed: "openai/text-embedding-3-small",
  },
  {
    label: "Google Gemini",
    keyPrefix: "AIza",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    chat: "gemini-2.5-flash-lite",
    embed: "gemini-embedding-001",
  },
  {
    label: "Groq",
    keyPrefix: "gsk_",
    url: "https://api.groq.com/openai/v1",
    chat: "llama-3.1-8b-instant",
    noEmbeddings: true,
  },
  {
    label: "OpenAI",
    keyPrefix: "sk-",
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

/** A pasted API key or server URL, as the URL (and key) to connect to. */
export function readEndpointInput(text: string): EndpointInput {
  const value = text.trim();
  if (!value) return { error: "Paste an API key or a server URL." };
  // Keys have none of a URL's punctuation; host names like `ollama` are short.
  if (!/[\s:/.]/.test(value)) {
    const provider = KEY_PROVIDERS.find((p) => value.startsWith(p.keyPrefix));
    if (provider) return { url: provider.url, key: value, provider };
    if (value.length >= 20)
      return {
        error:
          "Horde can't tell which provider this key is for. Paste the provider's API URL here and the key in the key field.",
      };
  }
  const url = value.includes("://") ? value : `http://${value}`;
  return { url, key: null };
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
  const read = readEndpointInput(text);
  return "provider" in read && read.provider ? read.provider.label : "";
}

export const COMPATIBLE_PROVIDERS_TIP =
  "Any service with an OpenAI-compatible API works. Paste just the key for OpenRouter, OpenAI, Google Gemini or Groq. For others (Mistral, DeepSeek, Together, …) paste the provider's API URL, then the key. For a server you run (Ollama, LM Studio, llama.cpp, vLLM) paste its address, e.g. 192.168.1.50:11434.";
