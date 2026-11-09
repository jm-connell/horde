import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

/**
 * An `<img>` that fades in once it has loaded instead of painting in pieces.
 * A cached image is already complete when it mounts and shows at once. If it
 * fails to load it is shown anyway, so the browser's broken-image state and
 * the alt text stay visible, unless a `fallback` is given: then that shows
 * instead (video cards use their plain placeholder, not a broken frame).
 * `retrySrcs` are tried in turn before giving up on `src` (another copy of
 * the same picture, such as YouTube's stable thumbnail URLs).
 */
export default function FadeImage({
  alt,
  className = "",
  onLoad,
  onError,
  fallback,
  retrySrcs,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  alt: string;
  fallback?: ReactNode;
  retrySrcs?: string[];
}) {
  const [loaded, setLoaded] = useState(false);
  // The source that failed (and how many retries it used): a new `src` gets
  // its own try.
  const [failed, setFailed] = useState<{ src?: string; tries: number }>({
    tries: 0,
  });
  const tries = failed.src === props.src ? failed.tries : 0;
  const retries = retrySrcs?.filter((r) => r && r !== props.src) ?? [];
  const src = tries === 0 ? props.src : retries[tries - 1];
  if (fallback !== undefined && tries > retries.length) return <>{fallback}</>;
  return (
    <img
      {...props}
      key={src}
      src={src}
      alt={alt}
      ref={(img) => {
        if (img?.complete && img.naturalWidth > 0 && !loaded) setLoaded(true);
      }}
      data-loaded={loaded ? "true" : "false"}
      onLoad={(e) => {
        setLoaded(true);
        onLoad?.(e);
      }}
      onError={(e) => {
        if (tries < retries.length) {
          setFailed({ src: props.src, tries: tries + 1 });
          return;
        }
        setLoaded(true);
        if (fallback !== undefined)
          setFailed({ src: props.src, tries: tries + 1 });
        onError?.(e);
      }}
      className={`ui-fade-img ${className}`}
    />
  );
}
