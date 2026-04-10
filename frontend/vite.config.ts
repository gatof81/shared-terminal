import { defineConfig } from "vite";

export default defineConfig({
        server: {
                port: 5173,
                proxy: {
                        // Proxy REST calls to the backend so the frontend dev server handles
                        // them without CORS complexity during local development.
                        "/api": {
                                target: "http://localhost:3001",
                                changeOrigin: true,
                        },
                        // WebSocket proxy — Vite's proxy supports ws upgrade automatically.
                        "/ws": {
                                target: "ws://localhost:3001",
                                ws: true,
                                changeOrigin: true,
                        },
                },
        },
});
