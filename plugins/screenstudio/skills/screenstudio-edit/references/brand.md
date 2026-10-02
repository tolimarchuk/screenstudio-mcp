# Brand kits

A brand is the part of a video that belongs to the product or company, not to the edit: their colours on the backdrop, caption box and cursor, their click sound, their voice and music. Save it once with `screenstudio_brand`, then apply it to every project they ship. A style sets the timing and a look sets a starting frame; a brand sits on top of both.

## Save

`screenstudio_brand` with `action: "save"` and a `brand`:

```json
{
  "name": "Northwind",
  "colors": { "primary": "#1d4ed8", "secondary": "#0f172a", "text": "#ffffff" },
  "backdrop": "gradient",
  "captions": { "font": "sans-serif" },
  "cursor": { "set": "macos-tahoe", "size": 48 },
  "clickSound": null,
  "radius": 16,
  "shadow": 0.45,
  "padding": 0.07,
  "voice": "en-US-BrianMultilingualNeural",
  "music": "instrumental/Corporate Smile"
}
```

- **Name** becomes the file name: letters, digits, spaces and hyphens. Saving the same name again replaces the brand.
- **Backdrop.** `gradient` fades primary to secondary, top left to bottom right (without a secondary, to a darker primary). `color` is a flat primary. `look` keeps the backdrop of the look named in `from`, for brands that want a wallpaper behind their colours; it is the default when `from` is set, otherwise `gradient`. Image backdrops are not supported yet.
- **from** starts from a look (`screenstudio_catalog` lists them) and lets the brand replace what it names. Pick the look for the content; none is a default. Under a recipe or an explicit look in `screenstudio_plan_edit`, only the brand's own fields apply (plus the from look's backdrop with `backdrop: "look"`), so the recipe's cursor, clicks and frame stand.
- **Captions.** Text defaults to the brand's text colour, the box to the primary colour. With no text colour, white or near-black is chosen against the box. Contrast is judged as the viewer sees it at worst: the box laid over black and over white footage, see-through text laid over the box. Under 4.5:1 the brand switches to a dark (`#000000b3`) or light (`#ffffffd9`) box, whichever reads better, and the text colour too when neither box rescues it, and says so with the worst-case ratio.
- **Cursor set** must be one the app ships (`screenstudio_catalog` → cursorSets).
- **Voice and music** are not project settings. Applying a brand reminds you to pass them to `screenstudio_narrate`.

`action: "show"` returns the settings a brand compiles to and the reasons, without touching a project. `save` under an existing name replaces it and says so. `list` shows a brand file that no longer reads with its error, and `delete` removes it anyway. `toPreset` asks the app to save the project's settings with the brand over them as a Screen Studio preset, and says when this build cannot. `screenstudio_status` lists saved brands.

## Apply

`screenstudio_brand` with `action: "apply"`, `name` and `projectPath` on a project open in the editor. It is one `config` op through `screenstudio_editor_apply`: every setting changes live with its sidebar panel open (pass `show: false` to skip that), lands in the app's undo history, and saves unless `save: false`. It returns the changed keys, the checkpoint and the notes.

Apply the brand after the edit's look and before captions or narration, so narration captions written as subtitle files pick up the brand's caption colours.

With a plan, pass `brand` to `screenstudio_plan_edit` (or `recipeOverrides: { "brand": "<name>" }` with a recipe) instead: the brand's settings go into the plan's `config` op after the recipe's, and its voice and music replace the recipe's in the result's `recipe` field.

## Guidelines

- One accent, used sparingly. A gradient between two brand colours of similar lightness looks calm; between a bright and a dark one it looks dramatic. Check a frame with `screenstudio_editor_frame`.
- The recording must still be the brightest, sharpest thing in the frame. A saturated backdrop with a light UI works; a light backdrop around a light UI loses the window's edge, so raise `shadow`.
- Keep the caption box solid enough to read over any frame. Brand colour on the box is fine when the contrast holds.
