// vite.config.js
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
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
