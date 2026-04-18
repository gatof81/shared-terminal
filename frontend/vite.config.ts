import { defineConfig, loadEnv } from "vite";

// CSP and proxy targets are derived from VITE_API_URL so the same config
// works for:
//   - local loopback dev (no env var)   → http://localhost:3001
//   - laptop → LAN VM dev               → http://<vm-ip>:3001 via .env.local
//   - production build for Pages        → https://api.<your-domain> via Pages env
//
// Both the dev-server CSP header and the index.html meta tag are rewritten
// to match — browsers apply multiple CSPs as an intersection, so they have
// to agree or the stricter one wins and blocks the connection.

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const apiUrl = env.VITE_API_URL || "http://localhost:3001";
	const wsUrl = apiUrl.replace(/^http(s?):\/\//, "ws$1://");

	const csp = [
		"default-src 'self'",
		"script-src 'self' 'unsafe-eval' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		`connect-src 'self' ${apiUrl} ${wsUrl}`,
	].join("; ");

	return {
		plugins: [
			{
				name: "csp-meta-tag",
				transformIndexHtml(html: string) {
					// Replace whatever CSP meta tag is in index.html with one
					// built from VITE_API_URL. Runs for both dev and build.
					return html.replace(
						/<meta\s+http-equiv="Content-Security-Policy"[^>]*\/?>/,
						`<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
					);
				},
			},
		],
		server: {
			port: 5173,
			headers: {
				"Content-Security-Policy": csp,
			},
			proxy: {
				// REST proxy so relative /api/* calls in dev hit the real backend.
				"/api": {
					target: apiUrl,
					changeOrigin: true,
				},
				// WS proxy; frontend currently connects direct to wsUrl, kept
				// here for completeness.
				"/ws": {
					target: wsUrl,
					ws: true,
					changeOrigin: true,
				},
			},
		},
	};
});
