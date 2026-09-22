import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During local `npm run dev` (outside Docker), proxy API calls to a
// locally running api on :3000 so the React app can use same-origin
// relative paths ("/leads", ...) exactly like it does in production
// behind nginx (see web/nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/leads": "http://localhost:3000",
      "/conversion-events": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
