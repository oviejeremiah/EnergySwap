// vite.config.js
import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => {
    // `.env.local` is not in process.env when this file runs â€” Vite only
    // surfaces it to client code via import.meta.env. loadEnv is what makes the
    // guards below see locally-configured values, and what a deploy platform
    // populates into the real environment.
    const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
    // A production build without VITE_BACKEND_API_URL bakes the dev fallback
    // (`http://localhost:3000`) into the bundle, so every API call from every
    // visitor goes to their own machine. The deploy still succeeds and looks
    // healthy, which makes it a silent total outage rather than a loud failure.
    if (mode === 'production' && !env.VITE_BACKEND_API_URL) {
        throw new Error(
            'VITE_BACKEND_API_URL is not set. A production build without it ships a bundle that ' +
                'calls http://localhost:3000 on every visitor. Set it in the deploy environment ' +
                '(Netlify site settings), or build with `--mode development` if you really ' +
                'intend a local-only bundle.',
        );
    }

    // Same reasoning for WalletConnect: phone pairing needs a project id the
    // deploy environment actually owns. Without one, pairing fails silently.
    if (mode === 'production' && !env.VITE_WALLETCONNECT_PROJECT_ID) {
        throw new Error(
            'VITE_WALLETCONNECT_PROJECT_ID is not set. Phone sign-in needs it; set it in the ' +
                'deploy environment (Netlify site settings).',
        );
    }

    return {
    // Port moved off Vite's 5173 default. `strictPort` matters: without it
    // Vite silently increments to the next free port when 4300 is busy, which
    // leaves you staring at a blank page wondering why the API calls fail.
    // Failing loudly beats serving on an unexpected origin the backend's CORS
    // allowlist does not know about.
    server: {
        port: 4300,
        strictPort: true,
    },
    preview: {
        port: 4300,
        strictPort: true,
    },
    plugins: [
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
            protocolImports: true,
        }),
    ],
    resolve: {
        dedupe: ['lit', 'lit-html', '@lit/reactive-element', 'lit-element'],
    },
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
    },
    };
});
