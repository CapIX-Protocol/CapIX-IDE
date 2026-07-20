/**
 * Webview icon helper.
 *
 * VS Code's `$(codicon)` token syntax is only expanded by the workbench in
 * specific API surfaces (status bar items, quick picks, tree/item labels,
 * markdown with `supportThemeIcons`). It is NOT processed inside webview
 * HTML, where it renders as raw text like "$(chrome-maximize)".
 *
 * Webviews also cannot use the codicon font without relaxing the CSP
 * (`font-src`), so instead we inline tiny 16×16 SVGs that inherit
 * `currentColor`. Use `icon("name")` anywhere a template literal feeds
 * webview HTML.
 */

const PATHS: Record<string, string> = {
  add: '<path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  "arrow-up": '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  attachment:
    '<path d="M10.5 4.5 5 10a2.5 2.5 0 0 0 3.5 3.5l5.5-5.5a1.7 1.7 0 0 0-2.4-2.4L6 11.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  calendar:
    '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  check: '<path d="m3 8.5 3.5 3.5L13 4.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  "chevron-down": '<path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  "chevron-right": '<path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  "chrome-maximize": '<rect x="3" y="3" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  "debug-start": '<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>',
  "debug-stop": '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/>',
  discard: '<path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  edit: '<path d="M11.3 2.7a1.4 1.4 0 0 1 2 2L5 13l-2.6.6L3 11z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>',
  globe:
    '<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2.5 8h11M8 2.5c-3.5 3.6-3.5 7.4 0 11 3.5-3.6 3.5-7.4 0-11z" stroke="currentColor" stroke-width="1.2" fill="none"/>',
  history:
    '<path d="M3.5 8a4.5 4.5 0 1 1 1.3 3.2M3.5 8V5.5M3.5 8h2.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M8 5.5V8l1.8 1.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  infinity:
    '<path d="M4.5 10.5a2.5 2.5 0 1 1 0-5c3.5 0 3.5 5 7 5a2.5 2.5 0 1 0 0-5c-3.5 0-3.5 5-7 5z" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="m7.5 8.5 5-5M11 5l1.5 1.5M9 7l1.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  link: '<path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  loading:
    '<path d="M8 2.5a5.5 5.5 0 1 1-5.3 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  location: '<path d="M8 14s4.5-4.4 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.6 8 14 8 14z" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="6.5" r="1.6" fill="currentColor"/>',
  output:
    '<rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="m5 6.5 2 2-2 2M8.5 10.5H11" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  package:
    '<path d="m8 2 5.5 3v6L8 14l-5.5-3V5z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><path d="M2.5 5 8 8l5.5-3M8 8v6" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  pin: '<path d="M9.5 2.5 13.5 6.5l-3 .7-2.3 2.3-.7 3L5 10 3.5 8.5l3-.7 2.3-2.3z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M2.5 13.5 5.5 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>',
  refresh:
    '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  save: '<path d="M3 3h8l2 2v8H3z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><path d="M5.5 3v3h5V3M5.5 13V9.5h5V13" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  settings:
    '<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 2.5v1.8M8 11.7v1.8M2.5 8h1.8M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M11.9 4.1l-1.3 1.3M5.4 10.6l-1.3 1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  shield: '<path d="M8 2 3 4v4c0 3 2.1 5 5 6 2.9-1 5-3 5-6V4z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>',
  sparkle: '<path d="M8 2c.4 3 1.6 4.6 4.5 5-2.9.4-4.1 2-4.5 5-.4-3-1.6-4.6-4.5-5 2.9-.4 4.1-2 4.5-5z" fill="currentColor"/>',
  "symbol-misc": '<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  tool: '<path d="M10.8 2.6a3.2 3.2 0 0 0-4 4.3L3 10.7a1.6 1.6 0 0 0 2.3 2.3l3.8-3.8a3.2 3.2 0 0 0 4.3-4L11 7.7 8.3 5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>',
  trash:
    '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5 5.2 13h5.6l.7-8.5M6.8 7v4M9.2 7v4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  vm: '<rect x="2.5" y="3.5" width="11" height="7" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6 13.5h4M8 10.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  zap: '<path d="M8.8 2 3.5 9h3.3L6.2 14 12.5 6.5H8.9z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>',
};

const SPIN =
  '<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/>';

/**
 * Inline SVG for a codicon-style icon name (e.g. `icon("refresh")`).
 * Supports the `~spin` modifier (`icon("loading~spin")`) via SMIL, which
 * works in webviews without any extra CSS. Unknown names fall back to a
 * small dot so a typo never renders as raw "$(…)" text again.
 */
export function icon(name: string, size = 14): string {
  const spin = name.endsWith("~spin");
  const base = spin ? name.slice(0, -5) : name;
  const body = PATHS[base] ?? '<circle cx="8" cy="8" r="2" fill="currentColor"/>';
  return (
    `<svg class="cx-ic" width="${size}" height="${size}" viewBox="0 0 16 16" ` +
    `aria-hidden="true" style="vertical-align:-2px">${body}${spin ? SPIN : ""}</svg>`
  );
}
