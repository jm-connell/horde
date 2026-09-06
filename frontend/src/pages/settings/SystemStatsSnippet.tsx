import type { SystemStats } from "../../types";
import { formatSize } from "../../utils";

export default function SystemStatsSnippet({
  stats,
}: {
  stats: SystemStats | null;
}) {
  if (!stats) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  const cards: { label: string; value: React.ReactNode }[] = [];

  if (stats.cpu_model || stats.cpu_percent != null || stats.cpu_temp_c != null) {
    cards.push({
      label: "CPU",
      value: (
        <>
          {stats.cpu_model && (
            <span className="block text-xs text-gray-400">{stats.cpu_model}</span>
          )}
          <span className="block">
            {[
              stats.cpu_percent != null
                ? `${Math.round(stats.cpu_percent)}%`
                : null,
              stats.cpu_temp_c != null
                ? `${Math.round(stats.cpu_temp_c)}°C`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      ),
    });
  }

  if (stats.ram_used_bytes != null && stats.ram_total_bytes != null) {
    cards.push({
      label: "RAM",
      value: (
        <>
          {formatSize(stats.ram_used_bytes)} / {formatSize(stats.ram_total_bytes)}
          {stats.ram_percent != null
            ? ` (${Math.round(stats.ram_percent)}%)`
            : ""}
        </>
      ),
    });
  } else if (stats.ram_percent != null) {
    cards.push({
      label: "RAM",
      value: `${Math.round(stats.ram_percent)}%`,
    });
  }

  const gpu = stats.gpu;
  const gpuLines: string[] = [];
  if (gpu?.util_percent != null) {
    gpuLines.push(`${Math.round(gpu.util_percent)}%`);
  }
  if (gpu?.temp_c != null) gpuLines.push(`${Math.round(gpu.temp_c)}°C`);
  const gpuVram =
    gpu?.vram_used_bytes != null && gpu.vram_total_bytes != null
      ? `${formatSize(gpu.vram_used_bytes)} / ${formatSize(gpu.vram_total_bytes)}`
      : gpu?.vram_total_bytes != null
        ? formatSize(gpu.vram_total_bytes)
        : null;
  const gpuDetected = Boolean(gpu && (gpu.name || gpuLines.length || gpuVram));
  cards.push({
    label: "GPU",
    value: gpuDetected ? (
      <>
        {gpu?.name && (
          <span className="block text-xs text-gray-400">{gpu.name}</span>
        )}
        {gpuLines.length > 0 && (
          <span className="block">{gpuLines.join(" · ")}</span>
        )}
        {gpuVram && (
          <span className="block text-xs text-gray-500">VRAM {gpuVram}</span>
        )}
      </>
    ) : (
      <>
        <span className="block text-gray-400">None detected</span>
        <a
          href="/wiki/ops/environment/#gpu"
          className="mt-1 block text-xs text-accent hover:underline"
        >
            Why?
        </a>
      </>
    ),
  });

  if (stats.disk) {
    cards.push({
      label: "Disk",
      value: (
        <>
          {formatSize(stats.disk.used_bytes)} /{" "}
          {formatSize(stats.disk.total_bytes)}
          <span className="block text-xs text-gray-500">
            {formatSize(stats.disk.free_bytes)} free
          </span>
        </>
      ),
    });
  }

  if (cards.length === 0) {
    return (
      <p className="text-sm text-gray-500">No resource stats available.</p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5"
        >
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {c.label}
          </p>
          <div className="text-sm text-gray-200">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
