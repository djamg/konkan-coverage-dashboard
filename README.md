# Konkan Railway mobile coverage

A static dashboard showing Airtel LTE coverage and internet availability measured on train 22120 (Tejas Express) from Madgaon to Panvel and on to Nilaje, where the log ends, on 16 Oct 2026. The trip was 537 km, about 14 hours and 9,746 measurements.

It shows:
- headline numbers
- a route map coloured by internet or signal
- coverage along the route by distance
- station-to-station breakdown
- a ranked list of dead zones

## Files

```
index.html        page
style.css         styles (light + dark)
app.js            map, charts, tables
data/trip.json    the cleaned measurements
vendor/           Leaflet 1.9.4 (BSD-2-Clause)
```

There is no build step and no dependency outside this folder. The only external requests are Esri map tiles.

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/`.

## Run locally

`fetch()` doesn't work from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
