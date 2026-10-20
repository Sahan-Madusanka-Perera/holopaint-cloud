---
name: HoloPaint
description: A printer's proof sheet that turns a photo into a colouring page.
colors:
  surround: "#c9cacc"
  surround-ink: "#161617"
  surround-ink-2: "#393a3d"
  stock: "#ffffff"
  ink: "#141414"
  ink-2: "#5b5b5d"
  plate-photo: "#ececed"
  plate-outline: "#f8f8f8"
  hair: "#e1e1e2"
  cyan: "#009fe3"
  magenta: "#e6007e"
  yellow: "#ffe600"
  cyan-ink: "#0076ad"
  magenta-ink: "#c2006a"
typography:
  display:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(27px, 3.3vw, 44px)"
    fontWeight: 720
    lineHeight: 1.04
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 118"
  numeral:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "46px"
    fontWeight: 480
    lineHeight: 1
    letterSpacing: "-0.015em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 84"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 620
    lineHeight: 1.45
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 620
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 86"
  slug:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 560
    lineHeight: "16px"
    letterSpacing: "0.01em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 80"
  button:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 620
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 104"
rounded:
  none: "0px"
spacing:
  margin: "56px"
  margin-top: "72px"
  margin-mobile: "40px"
  margin-top-mobile: "58px"
  mark-gap: "10px"
  mark-len: "22px"
  plate-gap: "28px"
  inset: "24px"
  stack: "14px"
  action-gap: "12px"
components:
  button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "44px"
  button-ink-hover:
    backgroundColor: "#2e2e30"
  button-line:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "44px"
  button-line-hover:
    backgroundColor: "#f0f0f1"
  sheet:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "72px 56px 56px"
    width: "min(1120px, 100%)"
  plate-photo:
    backgroundColor: "{colors.plate-photo}"
    rounded: "{rounded.none}"
    width: "100%"
  plate-outline:
    backgroundColor: "{colors.plate-outline}"
    rounded: "{rounded.none}"
    width: "100%"
  colour-bar-patch:
    rounded: "{rounded.none}"
    width: "58px"
    height: "12px"
    typography: "{typography.slug}"
  ink-chip:
    rounded: "{rounded.none}"
    width: "30px"
    height: "30px"
  ink-chip-selected:
    rounded: "{rounded.none}"
    width: "30px"
    height: "30px"
  tool-chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    width: "30px"
    height: "30px"
---

# Design System: HoloPaint

## Overview

**Creative North Star: "The Proof Sheet"**

The page is a printer's proof sheet laid in a viewing booth. A single sheet of white proof stock sits on a neutral grey surround; everything inside the trim is the job, everything in the margin is the press's own bookkeeping. The photo is the colour proof, the colouring page is the black plate, and the job's progress is the colour bar: Upload is cyan, Queue is magenta, Trace is yellow, Ready is key black. Registration black does all the talking; the four process inks appear only as the press uses them, as patches and as marks of state.

Density is low and the composition is literal. Crop marks sit at the four corners of the trim, registration targets sit at mid-height in the side margins, the colour bar is centred in the top margin, and a condensed slug line runs along the bottom margin carrying fixed facts on the left and the finished job's numbers on the right. The sheet is top-anchored under the masthead and grows downward only; nothing re-centres when content appears.

Once the page is ready, the reader can paint it by hand. The sheet turns into a press check: the photo plate gives way to a camera plate on the left, a third of the trim wide, showing the reader's hand in greyscale with its tracked skeleton; the colouring page takes the other two thirds, with an ink tray of square chips above it. The camera frame maps onto the tray and the page together, and a registration-target cursor carries the loaded ink. The outline is always multiplied over the paint, so the black plate prints on top of whatever the reader lays down.

Motion is press-like, not app-like. There is no easing anywhere. State changes are two-frame steps: the current colour-bar patch blinks between tint and solid on a `steps(1)` cycle, and the finished outline lands off register with cyan and magenta ghosts, then snaps into place in two steps over 180ms. Reduced motion removes both and shows the end state.

**Key Characteristics:**
- White proof stock on a neutral grey viewing-booth surround.
- Registration black for type and controls; process inks only for state.
- Printer's marks as structure: crop marks, registration targets, colour bar, slug line.
- One family, Archivo, used across its width axis: wide headline, condensed labels and slug.
- Square corners everywhere; hairlines instead of borders.
- Two-frame stepped motion, never eased.
- In paint mode, the reader's own inks on the page, and the outline always printed over them.

## Colors

A near-achromatic print shop: grey surround, white stock, registration black, with the four process inks held in reserve for job state.

### Primary
- **Registration Black** (ink): all type on the sheet, the primary button, crop marks and registration targets, and the Ready (key) patch.

### Secondary
- **Process Cyan** (cyan): the Upload patch and the dragover outline on the photo plate.
- **Process Magenta** (magenta): the Queue patch and the magenta ghost in the registration snap.
- **Process Yellow** (yellow): the Trace patch and text selection. On white its patch edge is drawn in a darker olive-yellow (#d4bf00) so the unfilled tint stays visible.

### Tertiary
- **Press Cyan** (cyan-ink): the legible, darker cyan for anything that must read as a line or text on stock: the focus ring, the caret, the intake mark on dragover.
- **Correction Magenta** (magenta-ink): the error state only: the correction-slip caret mark and the void diagonal through a failed colour-bar patch.

### Neutral
- **Viewing Booth Grey** (surround): the page background around the sheet, and the browser theme colour.
- **Booth Ink** (surround-ink): masthead wordmark and link on the surround.
- **Booth Ink Soft** (surround-ink-2): the colophon line under the sheet.
- **Proof Stock** (stock): the sheet itself and the outline plate's result surface.
- **Press Grey** (ink-2): secondary text on the sheet: plate labels, unreached patch names, hints, slug facts, the clock unit.
- **Photo Plate Grey** (plate-photo): the empty photo plate.
- **Outline Plate White** (plate-outline): the empty outline plate, a hair off stock.
- **Hairline** (hair): the 1px inset rule that frames the outline plate.

### The Reader's Inks
Twelve paint inks and paper, held as content in `app.js`, not as tokens: Black #141414, Vermilion #e8442e, Orange #f5921e, Yellow #ffd23f, Leaf #8cc63f, Green #1e9e58, Sky #4cb3ea, Blue #2f5fd0, Violet #7d4fc4, Rose #f283b6, Peach #f8c9a0, Umber #8a5634, and Paper (the eraser, which paints back to bare stock).

### Named Rules
**The Inks Are State Rule.** Cyan, magenta and yellow never fill a surface, never colour body copy and never decorate. They appear as colour-bar patches, as the dragover and focus signals, as the error mark, as selection, in the registration ghost, and as the tracked hand's skeleton on the camera plate. If an ink is on screen, it means something is happening.

**The Reader's Inks Rule.** The paint inks belong to the reader. They appear only as tray chips, on the page, and in the cursor's loaded tip; never in the interface itself.

**The Press Ink Rule.** Raw process cyan and magenta are for patches and fields; any ink that must read as a line or as text on white uses the darker press variant (cyan-ink, magenta-ink).

**The Tint-Then-Solid Rule.** A patch not yet reached is its ink at 16% on stock with a 60% ink hairline; a done patch is the solid ink with no edge; a failed patch keeps its tint and takes a magenta-ink edge and a 2px diagonal void.

## Typography

**Display Font:** Archivo (with system-ui, -apple-system, Segoe UI, sans-serif)
**Body Font:** Archivo
**Label/Mono Font:** Archivo, condensed via the width axis

**Character:** One variable family stretched across its width axis does the work of a type pairing: a wide, heavy, tightly tracked headline like a job title on a press sheet, and narrow, medium-weight labels like the slug a press operator reads. Weights sit at precise in-between values (480, 560, 580, 620, 720, 760) rather than named steps.

### Hierarchy
- **Display** (720, clamp(27px, 3.3vw, 44px), 1.04, width 118%, -0.03em, balanced wrap): the one headline at the top left of the trim.
- **Numeral** (480, 46px, 1, width 84%, tabular): the elapsed-seconds clock in the outline plate while a job runs; its unit is set at 0.45em in Press Grey.
- **Title** (620, 16px): the current step name above the clock.
- **Body** (400, 15px, 1.45): the correction-slip message; hints at 14px.
- **Body Small** (400, 13px): the cold-start note (max 32ch) and the colophon.
- **Label** (620, 13px, width 86%, 0.01em, sentence case): plate labels ("Photo", "Colouring page").
- **Slug** (560, 12px, width 80%, 0.01em, tabular): the slug line; colour-bar patch names use the same voice at 11.5px, weight 580.
- **Button** (620, 15px, width 104%, -0.005em): button labels.
- **Wordmark** (760, 17px, width 115%, -0.01em) beside the registration-target mark, on the surround.

### Named Rules
**The Width Axis Rule.** Hierarchy is carried by font-stretch as much as by size: wide (115-118%) for the wordmark and headline, near-normal (104%) for buttons, condensed (80-86%) for labels, slug, patch names and the clock. Do not add a second family.

**The Sentence Case Rule.** Every label, patch name, button and slug entry is sentence case. No uppercase tracking, no all-caps labels.

## Layout

The page is a centred column on the surround: masthead, sheet, colophon, all at `min(1120px, 100%)`. Body padding is 18px 24px 28px with a 16px gap (12px all round with 12px gap under 760px).

The sheet is top-anchored, sitting `clamp(4px, 2.5vh, 24px)` below the masthead, never vertically centred. Its padding is the printer's margin: a side and bottom margin (56px desktop, 40px mobile) and a deeper top margin (72px desktop, 58px mobile) that carries the colour bar. The trim inside holds the headline (30px below it, 22px on mobile) and two equal plates in a 1fr 1fr grid with a 28px gap, stacking to one column with a 22px gap under 760px.

Plates take the photo's aspect ratio (defaulting to 4:3) at full column width, capped at min(72vh, 860px), so neither plate letterboxes. While progress or the correction slip is showing, the outline plate holds a 15rem height floor. The actions row is absent until a result exists, then appears right-aligned below the plates with a 12px gap; on mobile the two buttons split the row equally.

In paint mode the plates become a 1fr 2fr grid with a 36px column gap: the camera plate on the left, the page on the right. Subgrid rows line the camera field up with the page field whatever height the ink tray wraps to, so the camera plate's label shares the page label's baseline and an empty band sits beside the tray. The gesture key sits directly under the camera field. Under 760px the page comes first (label, tray, page), then the camera plate with the field and the key side by side at 44:56. The actions row swaps to Download PNG and Done, with Done primary.

Crop marks are 22px hairlines set 10px outside the trim corners (16px and 7px on mobile). Registration targets (18px) sit at half-margin, mid-height, and are removed on mobile. The slug sits in the bottom margin, inset 16px from the trim edges; on mobile the extra fixed facts drop out, and once a job finishes the fixed facts yield entirely to the job numbers.

## Elevation & Depth

The sheet is the only lifted object: a sheet of paper resting in a booth, carrying a stacked soft shadow. Everything on the sheet is flat; plates are tonal fields, separated by background value and a 1px inset hairline, never by shadow. In print the shadow is removed.

### Shadow Vocabulary
- **Sheet on booth** (`box-shadow: 0 1px 1px rgba(20,20,20,0.06), 0 6px 14px -6px rgba(20,20,20,0.18), 0 28px 56px -28px rgba(20,20,20,0.42)`): the proof sheet only.
- **Inset hairline** (`box-shadow: inset 0 0 0 1px var(--hair)`): the outline plate frame; outlined buttons and patch edges use the same inset technique at 1-1.5px in their own ink.
- **Misregistration ghost** (`filter: drop-shadow(-4px 3px 0 rgba(0,159,227,0.55)) drop-shadow(3px -2px 0 rgba(230,0,126,0.4))`): the first frame of the registration snap only; it is the world's own misregister, never a resting style.

### Named Rules
**The One Sheet Rule.** Only the proof sheet casts a shadow. Nothing on the stock is lifted.

## Shapes

Square corners throughout (0px): sheet, plates, patches, buttons. Edges are drawn with inset hairlines (1px, 1.5px for outlined controls and the dragover ring) so they never change an element's box. The recurring silhouette is the registration target (a 13px ring, a full crosshair, a solid centre dot), used as the wordmark mark, the favicon, the side targets, the intake mark and the faint empty-plate placeholder. The correction slip's mark is an open miter caret, the proofreader's insertion sign. Diagonals appear only as the 2px void stroke through a failed patch.

## Components

### Buttons
Inked and square, like a stamp on the sheet.
- **Shape:** square (0px), 44px tall, 0 20px padding.
- **Ink (primary):** Registration Black fill with stock text; hover lifts to #2e2e30. Used for "Choose photo" and "Download PNG".
- **Line (secondary):** transparent with a 1.5px inset black rule; hover fills #f0f0f1. Used for "New photo" and "Try another photo".
- **Active / Disabled:** active nudges down 1px (removed under reduced motion); disabled sits at 40% opacity.
- **Focus:** 2px Press Cyan outline, 3px offset, everywhere on the page.

### Navigation
The masthead sits on the surround, outside the sheet: the wordmark with its registration-target mark at left, a single underlined text link at right (1px underline, 4px offset, thickening to 2px on hover).

### Colour Bar (signature)
One continuous strip of four abutted patches (58x12px, 52x10px on mobile) centred in the top margin, each with its sentence-case step name beneath in the slug voice. Unreached patches are 16% tints in Press Grey names; done patches go solid with black names; the current patch blinks between tint and solid once a second on `steps(1)`; a failed step keeps its tint, takes a Correction Magenta edge and a diagonal void stroke. Under reduced motion the current patch is shown solid.

### Plates
Two labelled fields side by side. The photo plate holds the intake (registration mark, "Choose photo", a "or drop one here" hint) and accepts drops; on dragover its field turns a pale cyan wash (#e3f2fa) with a 1.5px cyan inset rule and the mark turns Press Cyan. The outline plate shows a faint registration target when empty, then the progress readout or the correction slip, then the result on stock, which arrives through the registration snap.

### Progress Readout
Centred in the outline plate: step name (Title), a large condensed tabular clock in seconds, and, after a delay, a short cold-start note. Real elapsed time only.

### Correction Slip
Centred in the outline plate, max 340px: a Correction Magenta caret mark, a plain sentence saying what went wrong and how to fix it, and a line button to try again.

### Slug Line
Condensed tabular text in the bottom margin. Fixed facts in Press Grey on the left; after a job, the job id, dimensions and timings in black on the right. In paint mode the job numbers yield to live tracking facts: "Hand tracking on device", the delegate (GPU or CPU), and the measured frame rate.

### The Page
The result surface: a white stock block sized exactly to the outline's aspect, with the paint layer (a canvas at the outline's own pixel size) below and the outline image above it in `mix-blend-mode: multiply`. Paint can never cover a line. Fills bleed 2px under the lines so no white halo shows. In paint mode the mouse cursor over the page is the registration target.

### Ink Tray (paint mode)
A wrapping row of three groups above the page, 18px apart: inks, brush sizes, history. Chips are 30px squares on 4px gaps with a 1px inset edge at 16% ink, like colour-bar patches. The selected chip takes a 2px stock ring and a 1.5px black ring outside its box. Hover, and the hand's aim, draw a 2px black tick 7px under the chip; nothing moves, so the aim cannot flicker. Size chips show a dot in the loaded ink (5, 10, 16px). Undo and redo are tool chips with a 1.5px inset black rule and authored 1.6px-stroke arrow icons; disabled at 35%.

### Camera Plate (paint mode)
Labelled "Camera", with a "Turn off" text button (13px, underlined) on the label's baseline. The field takes the video's aspect, shows the mirrored feed in greyscale, and overlays the reach (the part of the frame mapped onto the page) as white crop marks, plus the tracked hand as a process-cyan skeleton with white joints. While starting, the registration mark blinks on `steps(1)` with "Starting camera" or "Loading hand tracking"; problems use the correction caret in Correction Magenta, one plain sentence, and a line button. After a second without a hand, a stock-white label at the bottom left says "Raise one hand".

### Gesture Key
A two-column list under the camera field (14px, 13px under 760px): gesture in weight 620, action in regular, both Press Grey, each row led by an 8px hairline box. The gesture being read turns its row black and fills its box, so the key doubles as the live readout. Two 13px notes follow: the mouse and touch fallback, and that video stays on the device.

### Hand Cursor
A 28px registration target with a white keyline, fixed to the viewport and blind to the pointer, carrying a round tip in the loaded ink (paper shows as stock with a grey edge). Pointing hides the target and grows the tip to the brush size; a pinch shrinks the target to 72%. The tip is the one round shape on the sheet besides the registration targets: it is the brush.

## Do's and Don'ts

### Do:
- **Do** keep every surface square (0px) and draw edges as inset hairlines.
- **Do** use process inks only to signal job state, dragover, focus, selection or error, and use cyan-ink and magenta-ink wherever an ink must read as a line or text.
- **Do** carry hierarchy with Archivo's width axis: wide for the headline, condensed for labels, slug, patch names and numerals.
- **Do** set state changes as two-frame steps with no easing (patch blink `steps(1)` over 1s; registration snap `steps(2)` over 180ms) and remove them under reduced motion.
- **Do** keep the sheet top-anchored with a deeper top margin (72px, 58px mobile) for the colour bar; let it grow downward only.
- **Do** size plates from the photo's aspect ratio at full width, with a 15rem floor on the outline plate while progress or the slip shows.
- **Do** show real timings with tabular numerals.
- **Do** write all copy in sentence case, plainly, with no em dashes.
- **Do** keep the outline multiplied over the paint, so no ink can cover a line.
- **Do** show hover and aim as a static tick under a chip, never as movement.

### Don't:
- **Don't** fill surfaces, backgrounds or body text with cyan, magenta or yellow.
- **Don't** round corners, or add borders that change box size; use inset hairlines.
- **Don't** add shadows to anything on the sheet; only the sheet itself rests on the booth.
- **Don't** use eased transitions, fades or slides for state changes.
- **Don't** add a second typeface or uppercase tracked labels.
- **Don't** vertically centre the sheet or reveal empty action rows before a result exists.
- **Don't** fake or animate progress that the job has not reported.
- **Don't** use the reader's paint inks anywhere in the interface outside the tray, the page and the cursor tip.
