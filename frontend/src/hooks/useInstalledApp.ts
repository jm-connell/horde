import { useEffect, useState } from "react";

const QUERY = "(display-mode: standalone)";

/** Running as an installed app (home screen or desktop PWA), not in a tab.
 *  iOS also reports a home-screen launch as `navigator.standalone`. */
function isInstalledApp(): boolean {
  return (
    window.matchMedia(QUERY).matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstalledApp(): boolean {
  const [installed, setInstalled] = useState(isInstalledApp);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setInstalled(isInstalledApp());
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return installed;
}
