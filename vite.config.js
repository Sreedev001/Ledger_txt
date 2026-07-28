import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Capacitor serves the built app from a local WebView origin, not from
  // domain root — relative asset paths avoid broken script/css references.
  base: "./",
});
