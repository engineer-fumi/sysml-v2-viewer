import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      // SSH API は同梱サーバー (npm run server) が提供する
      "/api": "http://localhost:3001",
    },
  },
});
