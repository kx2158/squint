# Squint (Tor Browser engine)

Squint on the Firefox engine from Tor Browser. Tor Browser does the privacy work: Tor routing, one
identical fingerprint for everyone, letterboxing, no history on disk. Squint is the look on top
(theme, start page, name, icon).

## Use
1. Run `setup.bat`. It finds Tor Browser, or downloads it from torproject.org and checks its SHA-256.
2. Open Tor Browser once, connect, close it (first time only).
3. Open **Squint** from the desktop.

## What stays safe
- Only colours, rounding and fades are changed in the interface. Sizes are not, because Tor Browser sizes
  the page area from the toolbars and a different size would make you stand out.
- Nothing is installed into Tor Browser's program folder. The look lives in its profile folder, so Tor
  Browser's own updater keeps working. Do not turn updates off.
- No extensions, no changes to `privacy.*` or `network.*` prefs.

## Updating
- Tor Browser: updates itself (Menu > About Tor Browser).
- Squint look: files in `skin/` and `pins.json` are copied into the profile on every start.

## Not here (on purpose)
Tor Browser forgets history and open tabs when closed. That is part of what protects you, so tab
restore, a password vault and Squint's old tab grouping from the Electron version are not part of this.
Use a password manager.
