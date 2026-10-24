import { useEffect, useState } from "react";
import { describeError } from "../../../apiErrors";
import { api } from "../../../api";
import ThemedSelect from "../../../components/ThemedSelect";
import type { AiConnectionTest } from "../../../types";
import {
  AI_PROVIDER_PRESETS,
  INPUT_INLINE,
  INPUT_KEY,
  PANEL_BTN,
} from "../constants";
import { providerKindLabel } from "../aiProviderUsage";
import { useSettingsPage } from "../context";

type Preset = (typeof AI_PROVIDER_PRESETS)[number];

function presetForUrl(url: string): Preset | undefined {
  const clean = url.trim().replace(/\/+$/, "");
  return AI_PROVIDER_PRESETS.find((p) => p.url === clean);
}

const PRESET_OPTIONS = [
  ...AI_PROVIDER_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    group: p.needsKey
      ? "Cloud providers (need an API key)"
      : "Local servers (your machine or network)",
  })),
  {
    value: "custom",
    label: "Other (type the URL)",
    group: "Any OpenAI-compatible URL",
  },
];

/**
 * URL + API key for one OpenAI-compatible endpoint, with a preset dropdown,
 * a connection test and a local-server finder. Saving sends the URL and key
 * together, so the server can drop a key saved for a different URL.
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
  /** Save the endpoint; ``preset`` is set when the URL came from the dropdown. */
  onSave: (url: string, key: string | null, preset?: Preset) => Promise<void>;
}) {
  const { showToast, showError } = useSettingsPage();
  const [url, setUrl] = useState(savedUrl);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiConnectionTest | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<
    { label: string; base_url: string; kind: string }[] | null
  >(null);

  useEffect(() => setUrl(savedUrl), [savedUrl]);

  const preset = presetForUrl(url);
  const dirty = url.trim() !== savedUrl || key.trim() !== "";
  const label = target === "chat" ? "AI provider" : "Embeddings provider";

  const save = async () => {
    await onSave(url.trim(), key.trim() || null, presetForUrl(url));
    setKey("");
  };

  const test = async () => {
    setTesting(true);
    const res = await api
      .testAiConnection({
        target,
        base_url: url.trim() || null,
        api_key: key.trim() || null,
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
    const kind = providerKindLabel(res.kind);
    showToast(`${res.detail || "Connected"}${kind ? ` · ${kind}` : ""}`);
    if (dirty) await save();
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
        <ThemedSelect
          aria-label={`${label} preset`}
          value={preset?.id ?? "custom"}
          options={PRESET_OPTIONS}
          onChange={(id) => {
            const next = AI_PROVIDER_PRESETS.find((p) => p.id === id);
            if (next) setUrl(next.url);
            setResult(null);
          }}
          className="w-64 max-w-full"
          buttonClassName="w-full"
          listClassName="max-h-80"
        />
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setResult(null);
          }}
          placeholder="https://… or http://192.168.x.x:11434"
          aria-label={`${label} URL`}
          className={INPUT_INLINE}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            keySet && url.trim() === savedUrl
              ? `Key saved (${keyMasked || "••••"})`
              : preset?.needsKey
                ? "API key"
                : "API key (optional)"
          }
          aria-label={`${label} API key`}
          className={INPUT_KEY}
        />
        <button
          type="button"
          disabled={testing || !url.trim()}
          onClick={() => void test()}
          className={PANEL_BTN}
        >
          {testing ? "Testing…" : dirty ? "Test and save" : "Test"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => void save()}
            className={PANEL_BTN}
          >
            Save without testing
          </button>
        )}
        {result?.ok && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Connected
            {providerKindLabel(result.kind)
              ? ` · ${providerKindLabel(result.kind)}`
              : ""}
          </span>
        )}
        {result && !result.ok && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            {result.detail || "Unreachable"}
          </span>
        )}
      </div>
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
              setUrl(row.base_url);
              setResult(null);
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
