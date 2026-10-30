import { useState } from "react";
import TakeoutImportDialog from "../../components/takeout/TakeoutImportDialog";
import {
  OneTimeImportNotice,
  TakeoutStatsToggle,
} from "../../components/takeout/TakeoutImport";
import { button } from "../../components/buttons";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import { useClearTakeout, useTakeoutHistory } from "../../queries/takeout";

function dateLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

/** Settings → Library: the account's imported YouTube history (Google Takeout). */
export default function YoutubeHistorySection() {
  const summary = useTakeoutHistory().data;
  const clear = useClearTakeout();
  const confirm = useConfirm();
  const { showToast, showError } = useToast();
  const [open, setOpen] = useState(false);
  const views = summary?.total_views ?? 0;

  const forget = async () => {
    const ok = await confirm({
      title: "Forget your YouTube history?",
      body: "Horde stops marking those videos as watched and stops using them for recommendations. Channels you followed and playlists you imported stay.",
      confirmLabel: "Forget history",
      danger: true,
    });
    if (!ok) return;
    try {
      await clear.mutateAsync();
      showToast("YouTube history forgotten");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not forget it");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-300">
          {views > 0 ? (
            <>
              {views.toLocaleString()} views of{" "}
              {(summary?.distinct_videos ?? 0).toLocaleString()} videos
              <span className="text-muted">
                {" "}
                · {dateLabel(summary?.first_watched_at)} to{" "}
                {dateLabel(summary?.last_watched_at)} · imported{" "}
                {dateLabel(summary?.last_imported_at)}
              </span>
            </>
          ) : (
            <span className="text-muted">Nothing imported yet.</span>
          )}
        </p>
        <span className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button("secondary", "sm")}
            onClick={() => setOpen(true)}
          >
            {views > 0 ? "Import a newer export" : "Import from Google Takeout"}
          </button>
          {views > 0 && (
            <button
              type="button"
              className={button("danger", "sm")}
              disabled={clear.isPending}
              onClick={() => void forget()}
            >
              Forget
            </button>
          )}
        </span>
      </div>
      {views > 0 && (
        <OneTimeImportNotice asOf={dateLabel(summary?.last_watched_at)} />
      )}
      <TakeoutStatsToggle />
      {open && <TakeoutImportDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
