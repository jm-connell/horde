import { describe, expect, it } from "vitest";
import {
  keyMismatch,
  keyProviderLabel,
  providerLabel,
  readEndpointInput,
} from "./aiProviders";

describe("readEndpointInput", () => {
  it("turns a key its provider issued into that provider's URL", () => {
    expect(readEndpointInput(" sk-or-v1-abc ")).toMatchObject({
      url: "https://openrouter.ai/api/v1",
      key: "sk-or-v1-abc",
    });
    expect(readEndpointInput("sk-proj-abc")).toMatchObject({
      url: "https://api.openai.com/v1",
    });
    // Built from parts so secret scanners do not read it as a real key.
    expect(
      readEndpointInput(["sk-abc", "T3Blbk", "FJxyz"].join(""))
    ).toMatchObject({
      url: "https://api.openai.com/v1",
    });
    expect(readEndpointInput("AIzaSyExample")).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
    expect(readEndpointInput("gsk_example")).toMatchObject({
      url: "https://api.groq.com/openai/v1",
    });
  });

  it("never sends a plain sk- key to OpenAI: other providers issue them too", () => {
    // DeepSeek and Anthropic keys.
    for (const key of [
      "sk-0123456789abcdef0123456789abcdef",
      "sk-ant-api03-abcdefghijklmnop",
    ])
      expect(readEndpointInput(key)).toHaveProperty("error");
  });

  it("does not read a key with URL punctuation as a host name", () => {
    expect(readEndpointInput("abc.def:ghi/jkl mno")).toHaveProperty("error");
    expect(readEndpointInput("a1b2c3d4e5f6a1b2c3d4e5f6")).toHaveProperty(
      "error"
    );
    expect(readEndpointInput("   ")).toHaveProperty("error");
  });

  it("reads an address as a URL, adding http:// and Ollama's port", () => {
    expect(readEndpointInput("192.168.1.50:1234")).toEqual({
      url: "http://192.168.1.50:1234",
      key: null,
    });
    expect(readEndpointInput("ollama")).toEqual({
      url: "http://ollama:11434",
      key: null,
    });
    expect(readEndpointInput("gpu-box/v1")).toEqual({
      url: "http://gpu-box:11434/v1",
      key: null,
    });
    expect(readEndpointInput("https://api.mistral.ai/v1")).toEqual({
      url: "https://api.mistral.ai/v1",
      key: null,
    });
  });
});

describe("keyMismatch", () => {
  it("stops a recognised key from going to another host", () => {
    expect(keyMismatch("http://192.168.1.50:11434/v1", "sk-or-v1-abc")).toMatch(
      /OpenRouter/
    );
    expect(keyMismatch("https://openrouter.ai/api/v1", "sk-or-v1-abc")).toBe(
      ""
    );
    // Keys Horde cannot place may go to the URL they were typed with.
    expect(keyMismatch("https://api.deepseek.com/v1", "sk-0123abcd")).toBe("");
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
