# Brand typefaces

**Production:** upload the clinic's licensed font files in *Brand Brain → Brand
typeface files*. They are stored in a private storage bucket and never enter
this public repository (`.gitignore` refuses font binaries in this folder).

**Local development only:** drop the same files here; `lib/brand-card.ts` reads
this folder first. Either way the cards switch from the open stand-in to the real
type and the "stand-in … type" note in the card corner disappears for that role.

| Face | Used for | File name must contain |
|---|---|---|
| Canela (Commercial Type) | headlines | `canela` |
| Nexa (Fontfabric) | body, kicker, footer | `nexa` |
| Rische | body (if Nexa is absent) | `rische` |

Weights are read from the file name too (`bold`, `semibold`, `medium`;
`italic` for style), e.g. `Canela-Medium.otf`, `Nexa-Regular.otf`,
`Nexa-Bold.otf`. Accepted formats: `.otf`, `.ttf`, `.woff`.

Trial and demo builds (`Nexa-Trial-*`, `NexaDemo-*`, `CanelaTextTrial-*`) are
refused: an evaluation licence does not cover production social posts. Adobe
Fonts (Creative Cloud) does not provide files for server-side rendering —
desktop/app licences from the foundries (Fontfabric for Nexa, Commercial Type
for Canela) do.
