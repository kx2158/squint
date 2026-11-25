# Squint

Private, minimal browser on Chromium (via Electron). "Squint" is the current name: change `name` in brand.json and `productName` in
`package.json` and `title` in `main.js`.

## Windows: one click

Unzip, double-click `setup.bat`. It installs Node.js if missing, installs everything, fetches the filter lists,
optionally downloads Tor, adds a desktop shortcut and starts the browser. `run.bat` starts it afterwards.

## Run (manual)

```
npm install      # also pulls the uBlock Origin + EasyList filter lists into ./lists
npm start
npm run lists    # refresh the lists whenever you want
# optional installer: npm i -D electron-builder, then npx electron-builder
```

## What it does

- No sync, no telemetry, no component updater, no prefetch, no Safe Browsing, no spellcheck downloads.
  The browser UI runs in a session that cannot make any network request.
- Ad and tracker blocking from the uBlock Origin filter lists (uAssets) plus EasyList and EasyPrivacy,
  including cosmetic filters and scriptlets, compiled natively. Lists live on disk; nothing is fetched at runtime.
- Cookie banners: the uBO annoyances-cookies list plus an auto-reject script for the common consent platforms.
- Third-party cookies stripped both ways, referrer cut to origin, GPC and DNT sent, Client Data header removed,
  Chrome-matching user agent, HTTPS-only upgrade, WebRTC leak policy, permissions denied by default.
- DNS over HTTPS (Quad9 by IP, so no plaintext bootstrap lookup).
- Brave import: bookmarks, history, saved passwords (Windows, stored in an OS-encrypted local vault).
  Close Brave first. Passwords fill with Ctrl+Shift+L (press again to cycle accounts).

## Route (Settings -> Route)

- **Direct**: normal connection (encrypted DNS still on).
- **VPN / proxy**: all browser traffic through a SOCKS5/HTTP proxy, e.g. `socks5://10.64.0.1:1080` with Mullvad
  connected. Or leave this on Direct and run the VPN app system-wide.
- **Tor**: `socks5://127.0.0.1:9050`. Uses a Tor already listening on that port (Tor Browser's is 9150, set
  `torPort` in settings.json), or starts a bundled one: extract the Tor Expert Bundle from torproject.org so that
  `tor/tor.exe` (or `tor/tor/tor.exe`) sits next to `main.js`.
- Every route fails closed: if the proxy or Tor is down, pages do not load. They never fall back to direct.
- A small `vpn` / `tor` label shows in the address bar while a route is active. Tor is slow for video.

## Start screen

Pins live on the new tab page. Hover a tile to remove it, click `+` to add an address, or use
Menu -> Pin this page. No favicons are fetched, so pinning never makes a request.

## Limits

- uBlock Origin the extension is Manifest V2, which current Chromium no longer runs. This uses the same
  filter lists and the same engine family natively instead.
- A network observer still sees the IP addresses and TLS server names you connect to. DoH hides DNS,
  nothing short of a VPN or Tor hides destinations.
- No Widevine, so Netflix/Spotify-style DRM will not play. No Chrome extension support.
- Passwords that Brave stored with app-bound encryption (`v20`) and all cookies are not importable, so you log in once.
- Saving new passwords from a login form is not built yet.
- Keep Electron updated: the browser is only as patched as its Chromium.

Shortcuts: Ctrl+T/W/L/D/R, Ctrl+Tab, Ctrl+1..9, Alt+Left/Right, Ctrl +/-/0, F12, Ctrl+Shift+L.


## Tor circuits
Menu > Tor circuit (or click `tor` in the address bar) lists the relays your traffic goes through, with
countries, plus New circuit and New identity. Works with the Tor that Squint starts itself (it finds the Tor
inside `squint-tor\TorBrowser`, or `scripts\get-tor.ps1`). A Tor started by something else has no control port.

## Whole PC through Tor (off by default)
Settings > Privacy & network. Squint sets the Windows proxy to its own Tor, so apps that follow the Windows
proxy setting go through Tor. Apps that ignore it, and anything not TCP, still connect directly. The old
setting is restored when you turn it off or close Squint; `scripts\restore-network.bat` fixes it after a crash.

## Filters
Settings > Content filter: adult-site blocklist, a never-load domain list, and a word filter that hides any
post, comment or video card containing your words on every site.

## Fingerprint
Chromium cannot be made identical to everyone. Canvas, WebGL, audio, fonts, screen, time zone and more are
normalised, WebGPU is removed, and graphics are drawn in software so the graphics card cannot leak. Web workers
are not covered. For a truly shared fingerprint use the Tor Browser version.
