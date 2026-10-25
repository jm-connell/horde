import { useEffect, useState } from "react";
import { describeError } from "../../../apiErrors";
import { api } from "../../../api";
import type { AiConnectionTest } from "../../../types";
import { INPUT_INLINE, INPUT_KEY, PANEL_BTN } from "../constants";
import HelpTip from "../../../components/HelpTip";
import {
  COMPATIBLE_PROVIDERS_TIP,
  keyMismatch,
  keyProviderLabel,
  providerFor,
  providerLabel,
  readEndpointInput,
  type AiProvider,
} from "../aiProviders";
import { useSettingsPage } from "../context";

/**
 * One OpenAI-compatible endpoint from a single field: paste an API key (its
 * provider is recognised) or a server URL, with a key field for servers that
 * need one. Connecting tests it and names the provider it found. Saving sends
 * the URL and key together, so the server can drop a key saved for a
 * different URL.
 */
export default function EndpointFields({
  target,
  savedUrl,
  keySet,
  keyMasked,
  onSave,
}: {
  target: "chat" | "embed";
  savedUrl: string;
  keySet: boolean;
  keyMasked: string;
  /**
   * Save the endpoint; ``provider`` is set when Horde recognised it. Resolves
   * to the URL as saved (normalised), or ``null`` when saving failed.
   */
  onSave: (
    url: string,
    key: string | null,
    provider?: AiProvider
  ) => Promise<string | null>;
}) {
  const { showToast, showError } = useSettingsPage();
  const [input, setInput] = useState(savedUrl);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiConnectionTest | null>(null);
  const [problem, setProblem] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<
    { label: string; base_url: string; kind: string }[] | null
  >(null);

  useEffect(() => setInput(savedUrl), [savedUrl]);

  const keyProvider = keyProviderLabel(input);
  const dirty = input.trim() !== savedUrl || key.trim() !== "";
  const label = target === "chat" ? "AI provider" : "Embeddings provider";

  /** The URL and key to use, or ``null`` after showing why not. */
  const read = () => {
    const parsed = readEndpointInput(input);
    if ("error" in parsed) {
      setProblem(parsed.error);
      return null;
    }
    const typedKey = key.trim();
    const mismatch = parsed.key ? "" : keyMismatch(parsed.url, typedKey);
    if (mismatch) {
      setProblem(mismatch);
      return null;
    }
    return { ...parsed, key: parsed.key ?? (typedKey || null) };
  };

  const save = async (
    url: string,
    apiKey: string | null,
    provider?: AiProvider
  ) => {
    const saved = await onSave(url, apiKey, provider ?? providerFor(url));
    if (saved === null) return;
    setInput(saved);
    setKey("");
  };

  const connect = async () => {
    const ep = read();
    if (!ep) return;
    setTesting(true);
    const res = await api
      .testAiConnection({
        target,
        base_url: ep.url,
        api_key: ep.key,
      })
      .catch((err) => {
        showError(`Connection test failed: ${describeError(err)}`);
        return null;
      });
    setTesting(false);
    setResult(res);
    if (!res) return;
    if (!res.ok) {
      showToast(res.detail || "Unreachable");
      return;
    }
    const url = res.base_url ?? ep.url;
    showToast(`Connected to ${providerLabel(url, res.kind)}`);
    if (dirty)
      await save(url, ep.key, ep.provider ?? providerFor(url, res.kind));
  };

  const saveUntested = async () => {
    const ep = read();
    if (ep) await save(ep.url, ep.key, ep.provider);
  };

  const detect = async () => {
    setDetecting(true);
    const res = await api.detectAiServers().catch((err) => {
      showError(`Could not look for servers: ${describeError(err)}`);
      return null;
    });
    setDetecting(false);
    setFound(res?.servers ?? []);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setResult(null);
            setProblem("");
          }}
          type={keyProvider ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste an API key or a server URL"
          aria-label={`${label} URL or API key`}
          className={`${INPUT_INLINE} sm:w-80`}
        />
        <HelpTip text={COMPATIBLE_PROVIDERS_TIP} />
        {!keyProvider && (
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              keySet && input.trim() === savedUrl
                ? `Key saved (${keyMasked || "••••"})`
                : "API key (if it needs one)"
            }
            aria-label={`${label} API key`}
            className={INPUT_KEY}
          />
        )}
        <button
          type="button"
          disabled={testing || !input.trim()}
          onClick={() => void connect()}
          className={PANEL_BTN}
        >
          {testing ? "Connecting…" : dirty ? "Connect" : "Test"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => void saveUntested()}
            className={PANEL_BTN}
          >
            Save without testing
          </button>
        )}
      </div>
      {(keyProvider || problem || result) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {keyProvider && !result && (
            <span className="text-muted">{keyProvider} key</span>
          )}
          {problem && <span className="text-amber-300">{problem}</span>}
          {result?.ok && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 font-medium text-emerald-400 ring-1 ring-emerald-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Connected · {providerLabel(result.base_url ?? input, result.kind)}
            </span>
          )}
          {result && !result.ok && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 font-medium text-amber-300 ring-1 ring-amber-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              {result.detail || "Unreachable"}
            </span>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={detecting}
          onClick={() => void detect()}
          className="text-xs text-muted underline-offset-2 hover:text-gray-300 hover:underline"
        >
          {detecting ? "Looking…" : "Find a server on this machine"}
        </button>
        {found && found.length === 0 && (
          <span className="text-xs text-muted">
            Nothing answered on the usual ports (Ollama 11434, LM Studio 1234,
            llama.cpp 8080).
          </span>
        )}
        {found?.map((row) => (
          <button
            key={row.base_url}
            type="button"
            className={PANEL_BTN}
            onClick={() => {
              setInput(row.base_url);
              setKey("");
              setResult(null);
              setProblem("");
              setFound(null);
            }}
          >
            Use {row.label} · {row.base_url}
          </button>
        ))}
      </div>
    </div>
  );
}
