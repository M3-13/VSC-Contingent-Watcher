# Rebuilding the icons

Sources live in `media/icon-source/`:

| File | Output |
| --- | --- |
| `icon.svg` | `media/icon.png` (128x128 marketplace icon) |
| `glyphs/uE0XX-<id>.svg` | `media/contingent-icons.woff` (status bar icon font) |

The glyphs are 16x16, single colour, filled paths only (icon fonts cannot carry strokes; cut-outs
are drawn as a counter-wound sub-path, because the font rasteriser uses the non-zero fill rule).
The `uE0XX-` filename prefix sets the codepoint and the rest of the name is the glyph name.

There are four styles. Each has five levels, from 4 (full: plenty left) to 0 (empty: exhausted),
so the status bar can map the remaining quota onto `<style>-<level>`:

| Style | Icon ids (`$(…)`), level 4 … 0 | Codepoints | Shape |
| --- | --- | --- | --- |
| gauge | `contingent-level-4` … `contingent-level-0` | `\E001` … `\E005` | AI fuel gauge: four arc segments above a sparkle |
| battery | `contingent-battery-4` … `contingent-battery-0` | `\E006` … `\E00A` | horizontal battery with four cells, filling from the left |
| ring | `contingent-ring-4` … `contingent-ring-0` | `\E00B` … `\E00F` | progress ring in four quarters, clockwise from 12 o'clock, sparkle in the centre |
| bars | `contingent-bars-4` … `contingent-bars-0` | `\E010` … `\E014` | four ascending signal bars |

Shared visual rules, so the styles read as one family next to codicons:

- A lit segment is solid (arcs and ring quarters 2.25 units thick, battery cells and bars solid).
  An unlit segment keeps its outline: a 1-unit arc on the outer edge (gauge, ring), a 1-unit
  hollow bar (bars), or nothing inside the 1-unit battery wall (battery).
- The sparkle is the same 4-point star in the gauge and the ring.
- The battery, bars and ring gaps sit on whole units, so they stay sharp at 16px on 1x screens.
  The battery uses the full 16-unit width (body 0–15, terminal 15–16); the bars span 0–15.
  The battery is too small for a sparkle cut-out to read at 16px, so it has none.

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

`media/icon-source/preview.png` shows all twenty glyphs (one row per style) rendered from the `.woff`, at 16px and 32px,
in white on `#181818` and black on `#f8f8f8`. After you change a glyph, render a page that loads the font with
`@font-face { font-family: ci; src: url(media/contingent-icons.woff) }`, view the glyphs at 16px and check
that each level is still legible. Keep the existing codepoints when adding glyphs: the extension and
users' settings refer to the ids, and `package.json` maps each id to its codepoint.
