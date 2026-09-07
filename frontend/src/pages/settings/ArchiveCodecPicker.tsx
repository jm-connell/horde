import type { DownloadVideoCodec } from "../../hooks/useSettings";
import type { SystemStats } from "../../types";
import { Chip } from "./ui";

const CODECS = [
  { id: "av1" as const, label: "AV1" },
  { id: "h264" as const, label: "H.264" },
  { id: "h265" as const, label: "H.265" },
];

export default function ArchiveCodecPicker({
  codec,
  onChange,
  encode,
}: {
  codec: DownloadVideoCodec;
  onChange: (codec: DownloadVideoCodec) => void;
  encode?: SystemStats["encode"] | null;
}) {
  const recommendedCodec = encode?.hw_hevc
    ? "h265"
    : encode?.hw_h264
      ? "h264"
      : null;

  return (
    <div>
      <p className="text-sm font-medium text-gray-200">
        Archive video codec
        <span className="ml-2 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent align-middle">
          Beta
        </span>
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        Horde plays the stored file as-is (no live transcode). YouTube only
        offers H.264 up to 1080p, so 1440p/4K on older devices means converting
        AV1 on this server — an AV1-compatible GPU makes that fast, CPU does
        not.{" "}
        <a
          href="/wiki/guides/downloads/#compatibility-codecs"
          className="text-accent hover:underline"
        >
          Learn more
        </a>
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CODECS.map((opt) => {
          const rec =
            opt.id === "av1"
              ? "Default — copy bitstream, no encode"
              : recommendedCodec === opt.id
                ? opt.id === "h265"
                  ? "Recommended for 4K"
                  : "Recommended for compatibility"
                : null;
          return (
            <Chip
              key={opt.id}
              active={codec === opt.id}
              onClick={() => onChange(opt.id)}
              title={rec ?? undefined}
            >
              {opt.label}
              {rec ? (
                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  {opt.id === "av1" ? "Default" : "Rec"}
                </span>
              ) : null}
            </Chip>
          );
        })}
      </div>
      {codec === "av1" && (
        <p className="mt-1.5 text-xs text-gray-500">
          YouTube’s default for high resolutions. Smallest files and highest
          quality: the video is copied, so the server GPU is not used. Older
          phones, tablets, TVs, and some browsers cannot decode it — Horde will
          not convert it later while you watch.
        </p>
      )}
      {codec === "h264" && (
        <p className="mt-1.5 text-xs text-gray-500">
          Largest files, widest playback. YouTube has no H.264 above 1080p, so
          1440p/4K is downloaded as AV1 then converted on this host (GPU if
          Horde can use it, otherwise slow software). 1080p and below copy
          YouTube’s H.264 with no encode.
        </p>
      )}
      {codec === "h265" && (
        <p className="mt-1.5 text-xs text-gray-500">
          Smaller 1440p/4K than H.264, and more devices can play it than AV1.
          YouTube does not offer H.265, so those resolutions are converted from
          AV1 on this host. 1080p and below still copy YouTube H.264.
        </p>
      )}
      {codec === "h264" && !encode?.hw_h264 && (
        <p className="mt-1.5 text-xs text-amber-400/90">
          1440p and 4K downloads will software-transcode (slow). 1080p and
          below still use YouTube’s H.264 with no extra encode.
        </p>
      )}
      {codec === "h265" && !encode?.hw_hevc && (
        <p className="mt-1.5 text-xs text-amber-400/90">
          1440p and 4K downloads will software-transcode to H.265 (very slow).
          1080p and below still use YouTube H.264.
        </p>
      )}
      {encode?.gpu_name &&
        !encode.ffmpeg_has_hw_encoder &&
        codec !== "av1" && (
          <p className="mt-1.5 text-xs text-amber-400/90">
            {encode.gpu_name} is visible but this Horde process cannot use it
            for encode. Pass the GPU into the horde container and use an ffmpeg
            build with NVENC/QSV/VAAPI.
          </p>
        )}
    </div>
  );
}
