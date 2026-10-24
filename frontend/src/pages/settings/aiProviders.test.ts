import { describe, expect, it } from "vitest";
import {
  keyProviderLabel,
  providerLabel,
  readEndpointInput,
} from "./aiProviders";

describe("readEndpointInput", () => {
  it("turns a key with a known prefix into its provider's URL", () => {
    expect(readEndpointInput(" sk-or-v1-abc ")).toMatchObject({
      url: "https://openrouter.ai/api/v1",
      key: "sk-or-v1-abc",
    });
    expect(readEndpointInput("sk-proj-abc")).toMatchObject({
      url: "https://api.openai.com/v1",
    });
    expect(readEndpointInput("AIzaSyExample")).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
    expect(readEndpointInput("gsk_example")).toMatchObject({
      url: "https://api.groq.com/openai/v1",
    });
  });

  it("reads anything else as a server URL, adding http:// when missing", () => {
    expect(readEndpointInput("192.168.1.50:11434")).toEqual({
      url: "http://192.168.1.50:11434",
      key: null,
    });
    expect(readEndpointInput("https://api.mistral.ai/v1")).toEqual({
      url: "https://api.mistral.ai/v1",
      key: null,
    });
    expect(readEndpointInput("ollama")).toEqual({
      url: "http://ollama",
      key: null,
    });
  });

  it("asks for the URL when a long key has no known prefix", () => {
    expect(readEndpointInput("a1b2c3d4e5f6a1b2c3d4e5f6")).toHaveProperty(
      "error"
    );
    expect(readEndpointInput("   ")).toHaveProperty("error");
  });
});

describe("providerLabel", () => {
  it("names known hosts, Ollama, and anything else generically", () => {
    expect(providerLabel("https://openrouter.ai/api/v1")).toBe("OpenRouter");
    expect(providerLabel("https://api.deepseek.com/v1")).toBe("DeepSeek");
    expect(providerLabel("http://host.docker.internal:11434/v1")).toBe(
      "Ollama"
    );
    expect(providerLabel("http://gpu-box:8000/v1", "ollama")).toBe("Ollama");
    expect(providerLabel("http://gpu-box:1234/v1")).toBe(
      "OpenAI-compatible server"
    );
    expect(providerLabel("")).toBe("");
  });

  it("names a key's provider while it is typed", () => {
    expect(keyProviderLabel("sk-or-v1-abc")).toBe("OpenRouter");
    expect(keyProviderLabel("http://localhost:1234")).toBe("");
  });
});
