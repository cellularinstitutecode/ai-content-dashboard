# Brand typefaces

Drop the clinic's licensed font files here and redeploy; `lib/brand-card.ts`
picks them up by file name and the brand cards switch from the open stand-in to
the real type (the "stand-in type" note in the card corner disappears).

| Face | Used for | File name must contain |
|---|---|---|
| Canela (Commercial Type) | headlines | `canela` |
| Nexa (Fontfabric) | body, kicker, footer | `nexa` |
| Rische | body (if Nexa is absent) | `rische` |

Weights are read from the file name too (`bold`, `semibold`, `medium`;
`italic` for style), e.g. `Canela-Medium.otf`, `Nexa-Regular.otf`,
`Nexa-Bold.otf`. Accepted formats: `.otf`, `.ttf`, `.woff`.

These files are licensed software: keep this directory out of any public
mirror. Adobe Fonts (Creative Cloud) does not provide files for server-side
rendering — desktop/app licences from the foundries do.
