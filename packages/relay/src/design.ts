/**
 * Loopsy design tokens — kept in sync with apps/mobile/lib/theme.dart.
 *
 * The web client (`/app`) and marketing landing (`/`) share these so the
 * Flutter app, the iPhone Safari fallback, and the marketing site all read as
 * the same product.
 */

export const COLORS = {
  bg: '#0B0D10',
  surface: '#14171C',
  surfaceAlt: '#1D2128',
  border: '#1F242B',
  accent: '#7AA2F7',
  accentDark: '#3954C4',
  good: '#9ECE6A',
  warn: '#E0AF68',
  bad: '#F7768E',
  fg: '#E7EAEE',
  muted: '#6B7280',
  // Tokyo Night terminal palette (matches loopsyTerminalTheme).
  ansiBlack: '#1A1B26',
  ansiRed: '#F7768E',
  ansiGreen: '#9ECE6A',
  ansiYellow: '#E0AF68',
  ansiBlue: '#7AA2F7',
  ansiMagenta: '#BB9AF7',
  ansiCyan: '#7DCFFF',
  ansiWhite: '#C0CAF5',
  ansiBrightBlack: '#414868',
  ansiBrightRed: '#FF7A93',
  ansiBrightGreen: '#B9F27C',
  ansiBrightYellow: '#FF9E64',
  ansiBrightBlue: '#7DA6FF',
  ansiBrightMagenta: '#BB9AF7',
  ansiBrightCyan: '#0DB9D7',
  ansiBrightWhite: '#D8E0F2',
} as const;

/**
 * Shared CSS reset + tokens. Inject this near the top of any document so
 * marketing pages and the web client read consistently.
 */
export const TOKENS_CSS = /* css */ `
:root {
  color-scheme: dark;
  --bg: ${COLORS.bg};
  --surface: ${COLORS.surface};
  --surface-alt: ${COLORS.surfaceAlt};
  --border: ${COLORS.border};
  --accent: ${COLORS.accent};
  --accent-dark: ${COLORS.accentDark};
  --good: ${COLORS.good};
  --warn: ${COLORS.warn};
  --bad: ${COLORS.bad};
  --fg: ${COLORS.fg};
  --muted: ${COLORS.muted};
  --radius-card: 16px;
  --radius-button: 10px;
  --radius-chip: 999px;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Inter', sans-serif;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, kbd, pre, .mono { font-family: var(--font-mono); }
::selection { background: rgba(122, 162, 247, 0.32); }
`;

/**
 * Shared SVG icon set (HugeIcons-style stroke). Inline SVG so we don't pay a
 * round-trip and don't need an icon font on CSP.
 */
export const ICONS = {
  loopArrow: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4l4 4-4 4"/><path d="M3.5 11.5V10a2 2 0 0 1 2-2H18.5"/><path d="M9.5 20l-4-4 4-4"/><path d="M20.5 12.5V14a2 2 0 0 1-2 2H5.5"/></svg>`,
  add: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  power: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"/><path d="M5.5 7.5a8 8 0 1 0 13 0"/></svg>`,
  refresh: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.7-6L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.7 6L3 16"/><path d="M3 21v-5h5"/></svg>`,
  send: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>`,
  mic: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10a7 7 0 0 1-14 0"/><path d="M12 17v4"/></svg>`,
  cmd: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17 9 12 4 7"/><path d="M12 19h8"/></svg>`,
  github: /* svg */ `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.7 5.6.7 11.9c0 5 3.3 9.2 7.8 10.7.6.1.8-.2.8-.5v-2c-3.2.7-3.8-1.4-3.8-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.7 2.7 1.2 3.4.9.1-.7.4-1.2.7-1.5-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.5 4.5-1.5 7.7-5.7 7.7-10.7C23.3 5.6 18.3.5 12 .5z"/></svg>`,
  apple: /* svg */ `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.4 12.6c0-2.7 2.2-4 2.3-4-1.3-1.8-3.2-2.1-3.9-2.1-1.7-.2-3.2.9-4.1.9-.9 0-2.2-.9-3.6-.9-1.9 0-3.6 1.1-4.5 2.7-1.9 3.3-.5 8.2 1.4 10.9.9 1.3 2 2.8 3.4 2.7 1.4-.1 1.9-.9 3.5-.9 1.6 0 2.1.9 3.5.9 1.5 0 2.4-1.3 3.3-2.7.7-.9 1.3-2 1.7-3.2-1.7-.7-2.9-2.4-2.9-4.3zM13.6 4.4c.7-.9 1.2-2.1 1.1-3.3-1 .1-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.2.1 2.3-.6 3-1.5z"/></svg>`,
  android: /* svg */ `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.1l1.4-2.4c.1-.2 0-.4-.1-.5-.2-.1-.4 0-.5.1l-1.4 2.4c-1.4-.6-2.9-1-4.5-1s-3.1.4-4.5 1L6.6 6.4c-.1-.2-.3-.2-.5-.1-.1.1-.2.3-.1.5l1.4 2.4C5 10.4 3.4 12.4 3.1 14.7h17.8c-.3-2.3-1.9-4.3-4.3-5.6zM7.5 13.4c-.4 0-.7-.3-.7-.7 0-.4.3-.7.7-.7s.7.3.7.7c0 .4-.3.7-.7.7zm9 0c-.4 0-.7-.3-.7-.7 0-.4.3-.7.7-.7s.7.3.7.7c0 .4-.3.7-.7.7zM3.1 15.4v6c0 .8.6 1.4 1.4 1.4h.7v3.5c0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6v-3.5h7.2v3.5c0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6v-3.5h.7c.8 0 1.4-.6 1.4-1.4v-6H3.1zM1.6 9.4c-.9 0-1.6.7-1.6 1.6V18c0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6v-7c0-.9-.7-1.6-1.6-1.6zM22.4 9.4c-.9 0-1.6.7-1.6 1.6V18c0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6v-7c0-.9-.7-1.6-1.6-1.6z"/></svg>`,
  laptop: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>`,
  globe: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>`,
  shield: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8.4-8 9c-4.5-.6-8-4-8-9V6l8-3Z"/></svg>`,
  bolt: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`,
  cloud: /* svg */ `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 17.5a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.7 1.5A4 4 0 0 0 6 17.5h11Z"/></svg>`,
} as const;

export const BRAND_NAME = 'Loopsy';
export const BRAND_TAGLINE = 'Your terminal, in your pocket.';
export const GITHUB_URL = 'https://github.com/leox255/loopsy';
