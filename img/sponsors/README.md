# Sponsor images

Drop image files in this folder and list them in `sponsors.json`. The game loads
that manifest at boot and shows the logos on the pitch hoardings, the menu and
the credits screen.

## Adding a sponsor

1. Put the file here, e.g. `img/sponsors/acme.png`
2. Add an entry to `img/sponsors/sponsors.json`:

```json
{
  "sponsors": [
    { "name": "ACME",   "file": "acme.png",   "url": "https://example.com" },
    { "name": "GLOBEX", "file": "globex.svg", "tier": "gold" }
  ]
}
```

Fields: `name` is required; `file` is required; `url` and `tier` are optional
(`tier` may be `gold`, `silver` or `bronze` and only affects billing size).

## Notes

- PNG, JPG, WEBP, GIF and SVG all work.
- Landscape logos around 400x140 look best on the hoardings.
- A missing or unreadable file is skipped silently — the game never fails to
  start because of a sponsor asset.
- Opening the game as a `file://` URL blocks `fetch`, so the manifest cannot be
  read that way. Serve the folder over HTTP (for example
  `python3 -m http.server`) to see the logos, or the game falls back to
  placeholder billboards.
