import ThemedSelect from "../../../components/ThemedSelect";
import { useAuth } from "../../../context/AuthContext";
import type { CatalogProgress } from "../../libraryCatalogProgress";
import SettingsSection, { fieldLabel } from "./SettingsSection";

type Choice = "default" | "on" | "off";

/** The channel's own "also search YouTube" choice (the YT switch in its search box). */
export default function SearchSection({
  catalogProgress,
  saving,
  onChange,
}: {
  catalogProgress: CatalogProgress | null;
  saving: boolean;
  /** `null` goes back to the server-wide default. */
  onChange: (value: boolean | null) => void;
}) {
  const { can } = useAuth();
  const editable = can("edit_metadata");
  const override = catalogProgress?.youtubeSearchOverride ?? null;
  const system = catalogProgress?.youtubeSearchSystem ?? true;
  const value: Choice = override == null ? "default" : override ? "on" : "off";
  return (
    <SettingsSection
      id="search"
      title="Search"
      description="Searching this channel always looks in your library and its indexed uploads. It can also ask YouTube, which sends your search text to YouTube."
      readOnlyNote={
        editable ? null : "Changing this needs the Edit metadata permission."
      }
    >
      <span className={fieldLabel}>Also search YouTube</span>
      <ThemedSelect<Choice>
        aria-label="Also search YouTube"
        value={value}
        options={[
          {
            value: "default",
            label: `Server default (${system ? "on" : "off"})`,
          },
          { value: "on", label: "On for this channel" },
          { value: "off", label: "Off for this channel" },
        ]}
        onChange={(next) => onChange(next === "default" ? null : next === "on")}
        disabled={!editable || saving || !catalogProgress}
        className="w-full"
        buttonClassName="w-full"
      />
    </SettingsSection>
  );
}
