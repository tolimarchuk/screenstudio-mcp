# Privacy: blur what should not be posted

A demo recorded on a real machine shows real things: API keys in a terminal, an email in a sidebar, a customer's phone number in a table, a link with a token in the address bar. Run `screenstudio_find_sensitive` on every video before it is published, and again after re-recording a beat.

## What it does

1. **Reads frames.** One every `everyMs` (1000 by default), plus one just before and one just after each screen change from `screenstudio_analyze`. The extra frames make a blur start and stop close to the moment the screen changed instead of up to a second early or late. A recording too long for `maxFrames` at that rate is read at a wider interval so the whole of it, ending included, is read; the notes give the interval used.
2. **Reads the text** in each frame with macOS text recognition, with language correction off so tokens are not "fixed" into words.
3. **Classifies it.** Emails, phone numbers (with separators, `+E.164`, or ten digits next to a phone label), API keys and tokens (`sk-`, `ghp_`, `xox`, `AKIA`, AWS secret keys, Stripe and Google keys, private key headers), JSON web tokens, hex keys and hashes (32 or more hex digits with letters among them, `0x` prefix included), long random-looking strings (slashes included, so base64 key bodies are whole), card numbers that pass the Luhn check, IP addresses (not loopback), links whose query carries a token (with or without `https://`, as an address bar shows them), passwords and secrets in `.env` lines, settings and connection strings (the value, not its name), and anything in `extraTerms`: plain words match case-insensitively, `/pattern/flags` is a regular expression. Use `extraTerms` for client names, project code names, account numbers or a person's name. Overlapping findings merge, so a term inside a longer secret widens the blur to the whole secret. Digits alone are IDs, not secrets: a post ID in a tweet link, an order number or a long run of digits OCR ran into nearby text is never flagged as a key, and digits in a link path are never read as a card number. A token in a link's query is still found.
4. **Follows each finding across frames.** The same value, or the same kind of value in the same place (OCR misreads a character now and then), seen again within two missed frames is one finding. Its blur runs from the last frame read without it to the first frame read after it, so nothing shows between frames, and its box is the padded union of every place it was seen. A value that was typed in is blurred from the first keystroke, because the partial text is already private.
5. **Lays out masks.** Screen Studio's mask track cannot hold overlapping masks, so each stretch with the same set of findings becomes one `sensitive-data` mask with a rect per finding (up to ten). Stretches shorter than 0.4s fold into a neighbour so the blur does not flicker. An existing blur mask grows to cover new findings (an `updateItem` op). A highlight or disabled mask hides nothing but still holds its time, so no blur can go there until it is removed; the notes name it, and the preview fills every detected box anyway.

Results show only a masked preview of each value (first and last two characters). The preview is a sheet of up to six frames that between them show every finding (plus the last frame each was seen in, when there is room), two across (three for portrait recordings), each at least 960px wide at the recording's own aspect. Every proposed blur and every blur mask already on the track is filled solid red, so the sheet never shows what a blur hides. Every finding seen in that frame is ringed in thick yellow on black so even a box on one line of small text stands out, and each ring carries only its number in `detections`. The strip under each frame lists its time and each finding's number, kind and masked value, never the value itself, so nothing on the frame is covered by a label. If the preview cannot be drawn, the result still comes back, with a note saying why.

## How to use it

- Run it with `apply: false` (the default) first. Look at the preview: every red box should sit on the private text with a margin, and nothing private should be left uncovered. Match a tag's number to `detections` to drop a false positive.
- If something expected is flagged (a commit hash in a git demo, a public demo email), pass `ignore` with that kind, or leave the op out. If something is missed, add it to `extraTerms`.
- Then run again with `apply: true`, or pass the returned `ops` to `screenstudio_editor_apply`. Either way the masks drop in live in the open editor, Cmd+Z undoes them, and the project is saved.
- Check the result with `screenstudio_editor_frame` at a few masked moments.
- For footage that scrolls fast or flashes text briefly, lower `everyMs` to 500 or 250 for that video.

## Limits

- It reads text only. Faces, avatars, profile photos, maps and pasted screenshots need a look by eye.
- Masks are fixed boxes. Text that moves within one frame interval (smooth scrolling) is covered where it was seen; if the preview shows a gap, lower `everyMs`.
- Boxes are 0-1 of the recorded frame. A window recording whose window was resized mid-take may need a manual check of the boxes after the resize.
- Small or low-contrast text can be missed. Findings read with low confidence are called out in the notes.
