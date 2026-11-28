import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

/**
 * An `<img>` that fades in once it has loaded instead of painting in pieces.
 * A cached image is already complete when it mounts and shows at once. If it
 * fails to load it is shown anyway, so the browser's broken-image state and
 * the alt text stay visible, unless a `fallback` is given: then that shows
 * instead (video cards use their plain placeholder, not a broken frame).
 *
 * `retrySrc` is tried once before giving up on a failed `src`. A YouTube
 * thumbnail also counts as failed when what loads is YouTube's grey 120x90
 * "no thumbnail" picture: a size that does not exist for a video is answered
 * with that picture, which loads without an error.
 */
/** YouTube's grey placeholder for a thumbnail size a video does not have. */
function isYoutubeNoThumbnail(img: HTMLImageElement): boolean {
  return (
    img.naturalWidth === 120 &&
    img.naturalHeight === 90 &&
    /^https:\/\/i\d?\.ytimg\.com\//.test(img.currentSrc || img.src)
  );
}

export default function FadeImage({
  alt,
  className = "",
  onLoad,
  onError,
  fallback,
  retrySrc,
  src,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  alt: string;
  fallback?: ReactNode;
  /** Another address for the same picture, tried once when `src` fails. */
  retrySrc?: string | null;
}) {
  const [loaded, setLoaded] = useState(false);
  // The source that failed: a new `src` gets its own tries.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const [retriedSrc, setRetriedSrc] = useState<string | undefined>(undefined);
  const retrying = Boolean(retrySrc) && retrySrc !== src && retriedSrc === src;
  const shown = retrying ? (retrySrc ?? undefined) : src;
  if (fallback !== undefined && failedSrc !== undefined && failedSrc === src)
    return <>{fallback}</>;
  /** `shown` did not give a picture: the other address, else the fallback. */
  const failed = () => {
    if (retrySrc && retrySrc !== src && !retrying) {
      setLoaded(false);
      setRetriedSrc(src);
    } else if (fallback !== undefined) setFailedSrc(src);
  };
  return (
    <img
      {...props}
      src={shown}
      alt={alt}
      ref={(img) => {
        if (
          img?.complete &&
          img.naturalWidth > 0 &&
          !loaded &&
          !isYoutubeNoThumbnail(img)
        )
          setLoaded(true);
      }}
      data-loaded={loaded ? "true" : "false"}
      onLoad={(e) => {
        if (isYoutubeNoThumbnail(e.currentTarget)) {
          failed();
          return;
        }
        setLoaded(true);
        onLoad?.(e);
      }}
      onError={(e) => {
        setLoaded(true);
        failed();
        onError?.(e);
      }}
      className={`ui-fade-img ${className}`}
    />
  );
}
