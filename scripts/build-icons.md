# Rebuilding the icons

Sources live in `media/icon-source/`:

| File | Output |
| --- | --- |
| `icon.svg` | `media/icon.png` (128x128 marketplace icon) |
| `glyphs/uE00X-<id>.svg` | `media/contingent-icons.woff` (status bar icon font) |

The glyphs are 16x16, single colour, filled paths only (icon fonts cannot carry strokes).
The `uE00X-` filename prefix sets the codepoint and the rest of the name is the glyph name:

| Icon id (`$(…)`) | Codepoint | Meaning |
| --- | --- | --- |
| `contingent-level-4` | `\E001` | 4 of 4 cells lit: plenty left |
| `contingent-level-3` | `\E002` | 3 of 4 cells lit |
| `contingent-level-2` | `\E003` | 2 of 4 cells lit |
| `contingent-level-1` | `\E004` | 1 of 4 cells lit |
| `contingent-level-0` | `\E005` | all cells empty: exhausted |

These ids are registered under `contributes.icons` in `package.json`.

Nothing here is a devDependency. Run the commands from the repository root; the build uses a temporary folder.

## Icon font

```sh
TMP=$(mktemp -d)
npx -y -p svgicons2svgfont@15.0.1 svgicons2svgfont \
  --fontName contingent-icons --height 1000 --descent 0 \
  --output "$TMP/contingent-icons.svg" media/icon-source/glyphs/*.svg
npx -y -p svg2ttf@6.1.0 svg2ttf "$TMP/contingent-icons.svg" "$TMP/contingent-icons.ttf"
npx -y -p ttf2woff@3.0.0 ttf2woff "$TMP/contingent-icons.ttf" media/contingent-icons.woff
```

The font embeds a build timestamp, so a rebuild is never byte-identical. That does not matter.

`--height 1000 --descent 0` maps the 16-unit grid onto a 1000-unit em that sits fully above
the baseline, the same layout as the codicon font, so the glyphs line up with built-in icons.

## Marketplace icon

This needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).

```sh
node -e "
const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  await p.setContent('<style>html,body{margin:0;background:transparent}</style>' + fs.readFileSync('media/icon-source/icon.svg', 'utf8'));
  await p.screenshot({ path: 'media/icon.png', omitBackground: true });
  await b.close();
})();"
```

## Check the result

`media/icon-source/preview.png` shows the five glyphs rendered from the `.woff`, at 16px and 32px,
in white on `#181818` and black on `#f8f8f8`. After you change a glyph, render a page that loads the font with
`@font-face { font-family: ci; src: url(media/contingent-icons.woff) }`, view the glyphs at 16px and check
that each level is still legible.
