# Recording a website

## A clean window

Never record the person's everyday browser: tabs, bookmarks, extensions, profile pictures and history all end up on camera. Open a separate, empty Chrome profile as a chromeless app window at the delivery size:

```sh
open -na "Google Chrome" --args --user-data-dir="<scratch>/chrome-demo" --no-first-run \
  --no-default-browser-check --app=https://example.com --window-size=1440,900 --window-position=560,250
```

1440×900 points records sharp on a Retina display and leaves zooms crisp. Close it (and delete the scratch profile) when done.

To find element positions precisely, add `--remote-debugging-port=<port>` to that same scratch profile and read `getBoundingClientRect()` for the elements you will point at. Window-local y = viewport y + the title bar (32 points for a Chrome app window). Use it only to read geometry and reset scroll; every recorded action is native input.

## Scout and rehearse

1. Screenshot every section at a few scroll positions. Name the beats from what is visually strong.
2. List interactive elements with their link targets. On-page demo widgets (toggles, tabs, pickers, calculators, "compare plans") are great beats. Skip anything that leaves the site, signs up, buys, books or emails ("Start for free", checkout, "Connect app", mailto).
3. Click each demo widget once to learn what it shows and how long it takes. Some show a state only briefly (a "Saved!" toast); time the zoom to catch it.
4. Reload before the take so every widget starts fresh, and scroll to the top.

## The take

- Script the beats in one run so there is no thinking time on camera: scroll with native wheel input, then read where the next target is, then glide and click.
- Before scrolling, move the pointer over the content you are scrolling.
- Hover what the narration names: glide to the row, card or price and rest there.
- Do a dry run of the whole script without recording first; then record.
- End back on the hero or the main call to action and hold for 2–3 seconds.
