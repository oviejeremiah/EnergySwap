// vite.config.js
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
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
});
