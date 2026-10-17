import BackgroundSection from "./appearance/BackgroundSection";
import FontSection from "./appearance/FontSection";
import InterfaceSection from "./appearance/InterfaceSection";
import ThemeSection from "./appearance/ThemeSection";
import CustomCssSection from "./CustomCssSection";
import { useAppearanceState } from "./useAppearanceState";

export default function AppearanceTab() {
  const appearance = useAppearanceState();

  return (
    <>
      <ThemeSection appearance={appearance} />
      <FontSection appearance={appearance} />
      <BackgroundSection appearance={appearance} />
      <InterfaceSection appearance={appearance} />
      <CustomCssSection />
    </>
  );
}
