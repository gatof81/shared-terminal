import { defineConfig } from "vite";

export default defineConfig({
        server: {
                port: 5173,
                // Serve a permissive CSP in dev so xterm.js (which uses new Function()
                // internally) and Vite HMR inline scripts can run without browser errors.
                // The meta tag in index.html covers production builds.
                headers: {
                        "Content-Security-Policy": [
                                "default-src 'self'",
                                "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
                                "style-src 'self' 'unsafe-inline'",
                                "img-src 'self' data: blob:",
                                "font-src 'self' data:",
                                // Allow direct WS connection to the backend (bypasses Vite HMR proxy).
                                "connect-src 'self' ws://localhost:3001 wss://localhost:3001 http://localhost:3001",
                        ].join("; "),
                },
                proxy: {
                        // Proxy REST calls to the backend so the frontend dev server handles
                        // them without CORS complexity during local development.
                        "/api": {
                                target: "http://localhost:3001",
                                changeOrigin: true,
                        },
                        // WebSocket proxy kept for completeness but not used — the frontend
                        // connects directly to ws://localhost:3001 to avoid HMR interference.
                        "/ws": {
                                target: "ws://localhost:3001",
                                ws: true,
                                changeOrigin: true,
                        },
                },
        },
});
