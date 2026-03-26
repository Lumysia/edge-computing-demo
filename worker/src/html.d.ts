/**
 * Type declaration for importing .html files as text modules.
 * Wrangler's "Text" rule (configured in wrangler.jsonc) bundles
 * .html files as string imports at build time.
 */
declare module '*.html' {
  const content: string;
  export default content;
}
