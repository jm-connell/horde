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
import "./index.css";

// Apply saved theme / motion / CSS before first paint to avoid flash.
const bootSettings = loadSettings();
applyTheme(bootSettings.theme, bootSettings.customColors);
applyMotionPrefs(bootSettings);
applyCustomCss(bootSettings.customCss);
applyPageId(window.location.pathname);
void applyUiFont({
  uiFont: bootSettings.uiFont,
  customFonts: bootSettings.customFonts,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
