import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Two pages: the public website (/) and the control room (/admin).
// Built to web/dist and served by the klausum-otp Worker (Workers Static Assets).
const page = (f: string) => fileURLToPath(new URL(f, import.meta.url)); // handles spaces in the folder name

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { index: page("./index.html"), admin: page("./admin.html") } },
  },
});
