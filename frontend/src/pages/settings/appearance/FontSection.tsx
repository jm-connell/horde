import { api } from "../../../api";
import { describeError } from "../../../apiErrors";
import { useConfirm } from "../../../context/ConfirmContext";
import { loadSettings } from "../../../hooks/useSettings";
import type { UiFont } from "../../../hooks/useSettings";
import { fontSelectOptions, labelFromFilename } from "../../../fonts";
import ThemedSelect from "../../../components/ThemedSelect";
import { FONT_SIZE_OPTIONS, INPUT, PANEL_BTN } from "../constants";
import { Chip, Section } from "../ui";
import { useSettingsPage } from "../context";
import type { AppearanceState } from "../useAppearanceState";

export default function FontSection({
  appearance,
}: {
  appearance: AppearanceState;
}) {
  const { q, match, settings, update, showToast, showError } =
    useSettingsPage();
  const { customFontDraft, setCustomFontDraft, addCustomFontFromUrl } =
    appearance;
  const confirm = useConfirm();

  return (
    <Section
      title="Font"
      description="App typeface and size. Inter (default) keeps the current stack."
      hidden={
        !!q &&
        !match(
          "font",
          "typeface",
          "typography",
          "google fonts",
          "jetbrains",
          "roboto",
          "ubuntu",
          "oxanium",
          "source sans",
          "font size",
          "text size"
        )
      }
    >
      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        <div
          className={
            match(
              "font",
              "typeface",
              "typography",
              "google fonts",
              "jetbrains",
              "roboto",
              "ubuntu",
              "oxanium",
              "source sans",
              "electrolize"
            )
              ? undefined
              : q
                ? "hidden"
                : undefined
          }
        >
          <p className="mb-2 text-sm font-medium text-gray-200">Typeface</p>
          <ThemedSelect
            aria-label="Font"
            value={settings.uiFont}
            options={fontSelectOptions(settings.customFonts)}
            onChange={(value: UiFont) => update({ uiFont: value })}
            className="w-full min-w-[12rem] max-w-[18rem]"
          />
          <p className="mt-2 text-sm text-gray-400">
            The quick brown fox jumps over the lazy dog 0123456789
          </p>
        </div>
        <div
          className={
            match("font size", "text size", "small", "medium", "large", "xl")
              ? undefined
              : q
                ? "hidden"
                : undefined
          }
        >
          <p className="mb-2 text-sm font-medium text-gray-200">Font size</p>
          <p className="mb-3 text-xs text-muted">
            Scales text across the app without extreme zoom steps.
          </p>
          <div data-font-size-control className="flex flex-wrap gap-2">
            {FONT_SIZE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={settings.fontSize === opt.value}
                onPointerDown={() => update({ fontSize: opt.value })}
                className="!py-1.5"
              >
                {opt.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      {settings.uiFont === "custom" && (
        <div className="mt-4 w-full max-w-2xl space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
          <label className="block space-y-1.5">
            <span className="text-sm text-gray-300">
              Google Fonts URL or family name
            </span>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={customFontDraft}
                onChange={(e) => setCustomFontDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomFontFromUrl(customFontDraft);
                  }
                }}
                placeholder="e.g. Nunito or fonts.googleapis.com/css2?family=…"
                className={`${INPUT} flex-1`}
              />
              <button
                type="button"
                className={PANEL_BTN}
                onClick={() => addCustomFontFromUrl(customFontDraft)}
              >
                Add
              </button>
            </div>
          </label>
          <div className="space-y-1.5">
            <span className="block text-sm text-gray-300">
              Or upload a font file
            </span>
            <input
              type="file"
              accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
              className="block w-full max-w-md text-sm text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-gray-200"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (!file) return;
                void (async () => {
                  try {
                    const result = await api.uploadFont(file);
                    const name = labelFromFilename(
                      result.filename || file.name
                    );
                    const current = loadSettings();
                    update({
                      customFonts: [
                        ...current.customFonts,
                        {
                          id: result.id,
                          name,
                          source: "file",
                        },
                      ],
                      uiFont: result.id,
                    });
                    showToast(`Saved “${name}”`);
                  } catch (err) {
                    showError(`Font upload failed: ${describeError(err)}`);
                  }
                })();
              }}
            />
            <p className="text-xs text-muted">
              Saved fonts are added to the dropdown permanently and stored with
              your Horde data.
            </p>
          </div>
        </div>
      )}

      {settings.customFonts.some((f) => f.id === settings.uiFont) && (
        <button
          type="button"
          className={`${PANEL_BTN} mt-4`}
          onClick={async () => {
            const id = settings.uiFont;
            const entry = settings.customFonts.find((f) => f.id === id);
            const next = loadSettings().customFonts.filter((f) => f.id !== id);
            const ok = await confirm({
              title: "Remove this font?",
              body: `${entry?.name ?? "The font"} is removed from the dropdown${
                entry?.source === "file"
                  ? " and its file is deleted from the server"
                  : ""
              }.`,
              confirmLabel: "Remove",
              danger: true,
            });
            if (!ok) return;
            if (entry?.source === "file") {
              try {
                await api.deleteFont(id);
              } catch (err) {
                showError(`Could not delete font: ${describeError(err)}`);
                return;
              }
            }
            update({
              customFonts: next,
              uiFont: "default",
            });
            showToast("Removed custom font");
          }}
        >
          Remove from dropdown
        </button>
      )}
    </Section>
  );
}
