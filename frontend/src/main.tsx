import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import {
  applyMotionPrefs,
  applyTheme,
  loadSettings,
} from "./hooks/useSettings";
import { applyCustomCss, applyPageId } from "./customCss";
import { applyUiFont } from "./fonts";
// The default UI font ships with the app, so a fresh install never asks
// Google Fonts for anything.
import "@fontsource/oxanium/400.css";
import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";
import "@fontsource/oxanium/700.css";
import "./index.css";
import { startConnectivity } from "./offline/connectivity";
import { offlineManager } from "./offline/manager";
import { registerServiceWorker } from "./offline/register";
import { runStorageMigrations } from "./storage";

runStorageMigrations();

// Apply saved theme / motion / CSS before first paint to avoid flash.
const bootSettings = loadSettings();
applyTheme(bootSettings.theme, bootSettings.customColors);
applyMotionPrefs(bootSettings);
applyCustomCss(bootSettings.customCss, bootSettings.customCssEnabled);
applyPageId(window.location.pathname);
void applyUiFont({
  uiFont: bootSettings.uiFont,
  customFonts: bootSettings.customFonts,
});

startConnectivity();
void offlineManager.init();
registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* React Router 7 wraps location updates in startTransition by default,
        so state set alongside a navigate() (setup finishing, the mini player,
        dialog focus) renders against the old URL first. Keep the v6
        behaviour: the location updates in the same render as that state. */}
    <BrowserRouter useTransitions={false}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
