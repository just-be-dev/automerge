import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  base: "/",
  build: { target: "esnext" },
  plugins: [wasm(), react()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  server: {
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err) => {
            const code = (err as NodeJS.ErrnoException).code
            if (code === "ECONNREFUSED" || code === "ECONNRESET") return
            console.error("[vite] ws proxy error:", err)
          })
        },
      },
      "/default-root": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
})
