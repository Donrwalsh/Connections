import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces so the container's port mapping works —
    // Vite defaults to localhost only, which is unreachable from outside
    // the container.
    host: true,
    port: 5173,
    watch: {
      // Bind mounts (especially on Mac/Windows) often don't emit native
      // filesystem events into the container, so Vite's watcher silently
      // never fires. Polling is less efficient but reliable everywhere.
      usePolling: true,
    },
    hmr: {
      // Ensures the browser's HMR websocket connects back to the right
      // host/port instead of guessing based on the container's internal address.
      clientPort: 5173,
    },
  },
});
