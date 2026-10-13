import { defineConfig } from 'vitest/config';

// A deliberately minimal setup: the frontend had no test runner at all, and the
// highest-value target - the rule that decides whether the trading controls may
// be used - needs nothing more than a DOM and an assertion library.
//
// `include` is narrowed to `test/` so the production bundle under `dist/` and
// anything Vite generates is never picked up.
export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['test/**/*.test.js'],
        reporters: 'default',
    },
});