import { useState, type ImgHTMLAttributes } from "react";

/**
 * An `<img>` that fades in once it has loaded instead of painting in pieces.
 * A cached image is already complete when it mounts and shows at once. If it
 * fails to load it is shown anyway, so the browser's broken-image state and
 * the alt text stay visible.
 */
export default function FadeImage({
  alt,
  className = "",
  onLoad,
  onError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { alt: string }) {
  const [loaded, setLoaded] = useState(false);
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
        onError?.(e);
      }}
      className={`ui-fade-img ${className}`}
    />
  );
}
