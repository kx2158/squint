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

## Comfort mode (on by default)
History, bookmarks, open tabs and saved logins stay on this computer. Cookies, site storage and cache are
still wiped every time you close the browser, so sites cannot recognise you between sessions.

- **Set the primary password once:** Settings > Privacy & Security > Logins > Use a primary password. It
  encrypts the saved logins; without it they are stored unencrypted on disk. Open `about:logins` to see them.
- **The trade:** this leaves Tor Browser's permanent private browsing, so a site may be able to tell you
  apart from other Tor Browser users (some features behave differently outside private mode). For anything
  risky open a Private Window (Ctrl+Shift+P), which behaves like stock Tor Browser.
- Turn it off with `"comfortMode": false` in `config.json`. Saved data is kept.
- Move over from the old Electron Squint: export bookmarks (HTML) and passwords (CSV) from its settings, then
  import them in Tor Browser (`about:logins` > menu > Import from a file). Delete the CSV afterwards.

Squint's old tab grouping from the Electron version is not part of this.
