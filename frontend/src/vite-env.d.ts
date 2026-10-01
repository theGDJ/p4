/// <reference types="vite/client" />

/**
 * Ambient types for the Vite build.
 *
 * `vite/client` supplies the module declarations for `*.css` imports (used by
 * main.tsx for the self-hosted @fontsource faces and index.css) and for asset
 * imports. Without this file `tsc --noEmit` rejects every stylesheet import.
 */
