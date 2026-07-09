import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import {
  applyMotionPrefs,
  applyTheme,
  loadSettings,
} from "./hooks/useSettings";
import "./index.css";

// Apply saved theme / motion before first paint to avoid flash.
const bootSettings = loadSettings();
applyTheme(bootSettings.theme, bootSettings.customColors);
applyMotionPrefs(bootSettings);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
