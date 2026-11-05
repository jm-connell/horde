import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

/**
 * An `<img>` that fades in once it has loaded instead of painting in pieces.
 * A cached image is already complete when it mounts and shows at once. If it
 * fails to load it is shown anyway, so the browser's broken-image state and
 * the alt text stay visible, unless a `fallback` is given: then that shows
 * instead (video cards use their plain placeholder, not a broken frame).
 */
export default function FadeImage({
  alt,
  className = "",
  onLoad,
  onError,
  fallback,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  alt: string;
  fallback?: ReactNode;
}) {
  const [loaded, setLoaded] = useState(false);
  // The source that failed: a new `src` gets its own try.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  if (
    fallback !== undefined &&
    failedSrc !== undefined &&
    failedSrc === props.src
  )
    return <>{fallback}</>;
  return (
    <img
      {...props}
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
        setLoaded(true);
        if (fallback !== undefined) setFailedSrc(props.src);
        onError?.(e);
      }}
      className={`ui-fade-img ${className}`}
    />
  );
}
