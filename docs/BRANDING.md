# Branding

The logo is at `web/public/brand/logo.svg`; PWA icons (`icon-192.png`, `icon-512.png`) are rendered from it with `npm run icons -w web`.

It is a vector redraw of the operator-supplied design: an orange-and-white roundel with the outline of Kenya, a hand casting a ballot into a ballot box marked with a camel, the name **THE NORTHERN IEBC** and the motto **tulinde Kura Zetu**.

**One deliberate change.** The supplied artwork's lower ring read “INDEPENDENT ELECTORAL AND BOUNDARIES COMMISSION”, the full name of the statutory commission. Unless the operator holds formal authorisation from the IEBC, using that name in the seal would suggest the platform *is* or is endorsed by the commission. The ring therefore reads **“INDEPENDENT ELECTION MONITORING · NORTHERN KENYA”**. If authorisation is obtained, change the `<textPath>` text inside `logo.svg` and regenerate the icons.

To use the original raster artwork instead, place it at `web/public/brand/logo.png` and change the `src` in `web/src/components/ui.tsx` (`Logo`) and the favicon link in `web/index.html`.

Palette (Tailwind tokens in `web/tailwind.config.js`): `navy-900 #0b1f3a` (primary), `brand-500 #e39046` / `brand-600 #d17426` (logo orange), `teal-600 #0f766e` (verified status), neutral greys. No party colours or government insignia are used.
