import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext } from "@playwright/test";
import { normalizeCustomCss, sanitizeCustomCss } from "../src/customCss";
import { spliceCorpus, type SpliceParts } from "../src/customCssCorpus";

/*
 * Browser-level check of the custom CSS policy: no sanitized stylesheet makes
 * Chromium contact a host other than the page's own.
 *
 * Every vector in customCssSanitize.vectors.json and every input of the seeded
 * splice corpus (customCssCorpus.ts, the same 3000 the vitest property test
 * uses) is sanitized by the real sanitizers and applied in an iframe, in
 * several contexts that make the browser fetch whatever url it names: the
 * input as a whole stylesheet (@import, and the vectors' own rules), a
 * background image, generated content and a web font in use. The page comes
 * from a stub origin with no Content-Security-Policy, so the app's CSP cannot
 * hide a leak, and a catch-all route answers every request: nothing reaches
 * the real network.
 *
 * Each vector gets a frame of its own (its rules target shared elements).
 * Corpus inputs share a frame, CORPUS_PER_FRAME at a time, each with its own
 * elements and font family; a frame that leaks is re-run one input at a time,
 * so a failure names the input. Every batch of frames also carries a canary
 * frame with unsanitized CSS that must reach canary.example in every context,
 * which proves the batch was really loaded and laid out, and a positive
 * control test checks that raw dangerous CSS is caught.
 */

const ORIGIN = "http://horde.test";
const SENTINEL = "evil.example";
const CANARY = "canary.example";
const CORPUS_SIZE = 3000;
const CORPUS_PER_FRAME = 10;
const FRAMES_PER_PAGE = 200;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const readShared = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(here, "..", "src", name), "utf-8")) as T;
const vectors = readShared<{ name: string; input: string }[]>(
  "customCssSanitize.vectors.json"
);
const corpus = readShared<SpliceParts>("customCssSanitize.corpus.json");

/** Where an input lands in the stylesheet a user would write; slot-scoped. */
const CONTEXTS: {
  name: string;
  wrap: (input: string, slot: number) => string;
}[] = [
  { name: "sheet", wrap: (input) => input },
  {
    name: "background",
    wrap: (input, s) => `#bg${s}{background-image:${input}}`,
  },
  { name: "content", wrap: (input, s) => `#ct${s}::before{content:${input}}` },
  {
    name: "font",
    wrap: (input, s) => `@font-face{font-family:hp${s};src:${input}}`,
  },
];

/**
 * A document with elements for the vectors' selectors (their fonts use the
 * family X) and, per slot, the elements the contexts style.
 */
function frameHtml(slots: number): string {
  const attr = `data-u="https://${SENTINEL}/attr"`;
  let css = "#fx{font-family:X}";
  let body = `<a href="#a" ${attr}>a</a><b>b</b><c>c</c><d>d</d><div>div</div><p>p</p><ul><li>li</li></ul><div id="fx">fx</div>`;
  for (let s = 0; s < slots; s += 1) {
    css += `#bg${s},#ct${s},#ff${s}{display:block;width:16px;height:16px}#ff${s}{font-family:hp${s}}`;
    body += `<div id="bg${s}"></div><div id="ct${s}"></div><div id="ff${s}">ff</div>`;
  }
  return `<!doctype html><html ${attr}><head><style>${css}</style></head><body ${attr}>${body}</body></html>`;
}

interface Case {
  label: string;
  input: string;
}

interface Frame {
  cases: Case[];
  /** Sanitized stylesheets, CONTEXTS.length per case. */
  sheets: string[];
}

interface Leak {
  label: string;
  input: string;
  sheets: string[];
  url: string;
}

/** Turns stylesheets into what gets applied, in order. */
type Sanitizer = (sheets: string[]) => string[];

/** What the app applies: `applyCustomCss` normalizes, then sanitizes. */
const frontendSanitizer: Sanitizer = (sheets) =>
  sheets.map((css) => sanitizeCustomCss(normalizeCustomCss(css)));

const unsanitized: Sanitizer = (sheets) => sheets;

/** backend/app/services/css_sanitize.py over `sheets`, in one process. */
function backendSanitize(sheets: string[]): string[] {
  const python = process.env.E2E_PYTHON || "python3";
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, "backend"))})`,
    "from app.services.css_sanitize import sanitize_custom_css",
    "sheets = json.load(sys.stdin)",
    "json.dump([sanitize_custom_css(s) for s in sheets], sys.stdout)",
  ].join("\n");
  const run = spawnSync(python, ["-I", "-c", script], {
    input: JSON.stringify(sheets),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`backend sanitizer failed: ${run.stderr || run.error}`);
  }
  return JSON.parse(run.stdout) as string[];
}

/** Vectors one per frame, corpus inputs CORPUS_PER_FRAME per frame. */
function caseGroups(): Case[][] {
  const groups: Case[][] = vectors.map((v) => [
    { label: `vector: ${v.name}`, input: v.input },
  ]);
  const inputs = spliceCorpus(corpus, CORPUS_SIZE);
  for (let k = 0; k < inputs.length; k += CORPUS_PER_FRAME) {
    groups.push(
      inputs
        .slice(k, k + CORPUS_PER_FRAME)
        .map((input, j) => ({ label: `corpus #${k + j}`, input }))
    );
  }
  return groups;
}

function wrapAll(group: Case[]): string[] {
  return group.flatMap((c, slot) => CONTEXTS.map((x) => x.wrap(c.input, slot)));
}

function buildFrames(groups: Case[][], sanitize: Sanitizer): Frame[] {
  const raw = groups.map(wrapAll);
  const out = sanitize(raw.flat());
  let at = 0;
  return groups.map((cases, k) => {
    const sheets = out.slice(at, at + raw[k].length);
    at += raw[k].length;
    return { cases, sheets };
  });
}

/** Unsanitized CSS that must reach the canary host in every context. */
function canaryFrame(batch: number): Frame {
  return {
    cases: [{ label: "canary", input: "" }],
    sheets: [
      `@import url(https://${CANARY}/sheet?b=${batch});`,
      ...CONTEXTS.slice(1).map((x) =>
        x.wrap(`url(https://${CANARY}/${x.name}?b=${batch})`, 0)
      ),
    ],
  };
}

/**
 * Load `frames` in pages of FRAMES_PER_PAGE (plus a canary frame each) and
 * return every request that left the page's origin, by frame index.
 */
async function probe(
  context: BrowserContext,
  frames: Frame[]
): Promise<{ frame: string; url: string }[]> {
  const page = await context.newPage();
  const foreign: { frame: string; url: string }[] = [];
  let inflight = 0;
  let lastActivity = Date.now();
  const settle = (): void => {
    inflight -= 1;
    lastActivity = Date.now();
  };
  page.on("request", (req) => {
    const url = req.url();
    if (!/^(https?|wss?):/i.test(url)) return;
    inflight += 1;
    lastActivity = Date.now();
    if (!URL.canParse(url) || new URL(url).origin !== ORIGIN) {
      foreign.push({ frame: req.frame().name(), url });
    }
  });
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  // The shell page for our origin, an empty answer for everything else.
  // no-store, so a URL named twice is requested (and seen) twice.
  await page.route("**/*", (route) => {
    if (route.request().url() === `${ORIGIN}/probe`) {
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><style>body{margin:0;display:flex;flex-wrap:wrap}iframe{border:0;width:24px;height:24px}</style><body></body>",
      });
    }
    // Playwright cannot fulfill a URL it cannot parse (a host with "(" in
    // it, say); aborting keeps that one off the network too.
    if (!URL.canParse(route.request().url())) return route.abort();
    return route.fulfill({
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: "",
    });
  });

  for (let start = 0; start < frames.length; start += FRAMES_PER_PAGE) {
    const batch = [
      ...frames
        .slice(start, start + FRAMES_PER_PAGE)
        .map((f, k) => ({ name: String(start + k), ...f })),
      { name: "canary", ...canaryFrame(start) },
    ].map((f) => ({
      name: f.name,
      html: frameHtml(f.cases.length),
      sheets: f.sheets,
    }));
    await page.goto(`${ORIGIN}/probe`);
    await page.evaluate(async (batch) => {
      await Promise.all(
        batch.map(
          (frame) =>
            new Promise<void>((resolve, reject) => {
              const el = document.createElement("iframe");
              el.name = frame.name;
              el.addEventListener(
                "load",
                () => {
                  const doc = el.contentDocument;
                  if (!doc) {
                    reject(new Error(`frame ${frame.name}: no document`));
                    return;
                  }
                  // Same as applyCustomCss: textContent, never HTML.
                  for (const sheet of frame.sheets) {
                    const style = doc.createElement("style");
                    style.textContent = sheet;
                    doc.head.appendChild(style);
                  }
                  // Force style and layout so every image and font the
                  // sheets reference is requested now.
                  for (const node of doc.querySelectorAll("*")) {
                    void getComputedStyle(node).backgroundImage;
                    void getComputedStyle(node, "::before").content;
                  }
                  void doc.body.offsetHeight;
                  resolve();
                },
                { once: true }
              );
              el.srcdoc = frame.html;
              document.body.appendChild(el);
            })
        )
      );
    }, batch);
    // Nothing in flight for 300 ms.
    await expect
      .poll(() => inflight === 0 && Date.now() - lastActivity > 300, {
        timeout: 15_000,
        intervals: [100],
      })
      .toBe(true);
    const canary = foreign
      .filter((r) => r.frame === "canary")
      .map((r) => new URL(r.url))
      .filter((u) => u.searchParams.get("b") === String(start))
      .map((u) => u.pathname)
      .sort();
    expect(canary, `page at frame ${start}: canary did not load`).toEqual(
      CONTEXTS.map((x) => `/${x.name}`).sort()
    );
  }
  await page.close();
  return foreign.filter((r) => r.frame !== "canary");
}

/** Every request a case makes off-origin, narrowed to the case that made it. */
async function leaks(
  context: BrowserContext,
  groups: Case[][],
  sanitize: Sanitizer
): Promise<Leak[]> {
  const frames = buildFrames(groups, sanitize);
  const hits = await probe(context, frames);
  const suspects = [...new Set(hits.map((h) => Number(h.frame)))].map(
    (k) => frames[k]
  );
  if (suspects.some((f) => f.cases.length > 1)) {
    return leaks(
      context,
      suspects.flatMap((f) => f.cases.map((c) => [c])),
      sanitize
    );
  }
  return hits.map((h) => {
    const frame = frames[Number(h.frame)];
    return { ...frame.cases[0], sheets: frame.sheets, url: h.url };
  });
}

test.describe("custom CSS never reaches another host", () => {
  test("frontend sanitizer output, vectors and corpus", async ({ context }) => {
    const groups = caseGroups();
    expect(groups.flat()).toHaveLength(vectors.length + CORPUS_SIZE);
    expect(await leaks(context, groups, frontendSanitizer)).toEqual([]);
  });

  test("backend sanitizer output, vectors and corpus", async ({ context }) => {
    const groups = caseGroups();
    const all = groups.flatMap(wrapAll);
    const out = backendSanitize(all);
    const table = new Map(all.map((css, k) => [css, out[k]]));
    const backendSanitizer: Sanitizer = (sheets) =>
      sheets.map((css) => {
        const clean = table.get(css);
        if (clean === undefined) throw new Error(`not sanitized: ${css}`);
        return clean;
      });
    // Where both sanitizers agree, the frontend test already loaded the
    // sheet; load the groups in which the backend's output differs.
    const front = buildFrames(groups, frontendSanitizer);
    const back = buildFrames(groups, backendSanitizer);
    const differing = groups.filter(
      (_, k) => front[k].sheets.join("\0") !== back[k].sheets.join("\0")
    );
    test.info().annotations.push({
      type: "groups where the backend output differs",
      description: `${differing.length} of ${groups.length}`,
    });
    expect(await leaks(context, differing, backendSanitizer)).toEqual([]);
  });

  test("the harness catches unsanitized CSS (positive control)", async ({
    context,
  }) => {
    const raw: Case[] = [
      { label: "url", input: `url(https://${SENTINEL}/x)` },
      { label: "protocol-relative", input: `url("//${SENTINEL}/x")` },
      { label: "escaped url", input: `\\75rl(//${SENTINEL}/x)` },
      { label: "image-set", input: `image-set("https://${SENTINEL}/x" 1x)` },
      { label: "@import", input: `@import "https://${SENTINEL}/x.css";` },
      { label: "rule", input: `a{background:url(https://${SENTINEL}/x)}` },
    ];
    const labels = raw.map((c) => c.label).sort();
    // One frame per input, and all of them sharing one frame (as the corpus
    // does): either way each input is caught and named.
    for (const groups of [raw.map((c) => [c]), [raw]]) {
      const found = await leaks(context, groups, unsanitized);
      expect([...new Set(found.map((l) => l.label))].sort()).toEqual(labels);
      for (const l of found) expect(new URL(l.url).host).toBe(SENTINEL);
      expect(await leaks(context, groups, frontendSanitizer)).toEqual([]);
    }
  });
});
