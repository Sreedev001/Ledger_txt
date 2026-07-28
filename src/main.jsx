import React from "react";
import ReactDOM from "react-dom/client";
import LedgerApp from "./LedgerApp.jsx";
import "./index.css";

// Wire the Android hardware back button to browser history.
// LedgerApp already pushes a history entry whenever it opens a sheet/dialog,
// so this makes back close those instead of exiting the app immediately.
if (window.Capacitor) {
  import("@capacitor/app").then(({ App }) => {
    App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        App.exitApp();
      }
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LedgerApp />
  </React.StrictMode>
);
