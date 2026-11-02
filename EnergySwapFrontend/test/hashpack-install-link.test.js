import { describe, it, expect } from 'vitest';
import { hashPackInstallMessage, HASHPACK_INSTALL_URL } from '../src/status-message.js';

// The HashPack install prompt is the platform's front door. It was shipped
// twice as a control-in-markup fix and failed in the field both times:
//
//   1. <a href> version - the status box hid itself 6 s later while the
//      message text stayed in the DOM with zero size, so the link could not
//      be clicked at all (measured: rect 0x0).
//   2. <button onclick="window.open(...)"> version - an inline event handler
//      attribute, which any CSP of `script-src 'self'` (no unsafe-inline)
//      refuses to execute. Click produced no console signal the user could
//      act on and no new tab.
//
// The markup must therefore be a plain anchor (works with zero JS and under
// any CSP), and the caller must keep the box open until the user acts.

describe('hashPackInstallMessage', () => {
    it('links directly to the HashPack download page', () => {
        expect(HASHPACK_INSTALL_URL).toBe('https://www.hashpack.app/download');
        expect(hashPackInstallMessage()).toContain(`href="${HASHPACK_INSTALL_URL}"`);
    });

    it('is a real anchor, not an inline-JS control', () => {
        const markup = hashPackInstallMessage();
        expect(markup).toContain('<a ');
        expect(markup).not.toContain('onclick');
    });

    it('opens safely in a new tab', () => {
        const markup = hashPackInstallMessage();
        expect(markup).toContain('target="_blank"');
        expect(markup).toContain('rel="noopener noreferrer"');
    });

    it('keeps the established look and the full instruction text', () => {
        const markup = hashPackInstallMessage();
        expect(markup).toContain('class="hashpack-install-btn"');
        expect(markup).toContain('create a Hedera testnet account');
        expect(markup).toContain('select your role again');
    });
});
