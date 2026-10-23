# Pit Stop

Find food along a drive and see how much time each stop **adds to the trip**: the drive off the freeway, to the restaurant, and back to your route (not time spent eating).

## How it works
1. Google **Routes API** gets your A→B route and its drive time.
2. Google **Places API (New)** searches along that route. For every place, Google returns the drive time *start → place* and *place → destination*.
3. Added time = those two legs − the normal trip. Missing on-ramps, backtracking and places 7 miles off the highway all show up as a bigger number automatically.

Your Google key stays hidden in a Netlify function (`netlify/functions/pitstop.mjs`). It's never in the web page.

## Files
```
index.html                     the app (iPhone-first)
icon.png                       home-screen icon
netlify/functions/pitstop.mjs  server code that talks to Google
```

## Setup (one time)
1. **Google Cloud:** create a project, turn on billing, and enable **Routes API** and **Places API (New)**. Create an API key and restrict it to those two APIs.
2. **GitHub:** create a repo called `pit-stop` and upload the files, keeping the `netlify/functions/` folders.
3. **Netlify:** Add new site → Import from GitHub → pick `pit-stop`. No build command needed.
4. **Netlify → Site configuration → Environment variables:** add `GOOGLE_MAPS_KEY` = your key, then redeploy.
5. On your iPhone, open the site in Safari → Share → **Add to Home Screen**.

Before the key is set up you can still see the app with sample data: add `?demo` to the URL.

## Using it
- Tap ◎ to start from where you are right now (best mid-trip).
- Pick a chip (Taco Bell, Culver's…) or leave it on "Any restaurant".
- **Max add** hides anything that would cost more than 5 / 10 / 15 min.
- **Least detour** vs **Next up** (soonest along the route).
- **Go with stop** opens Google Maps with the restaurant added as a stop.

## Cost
Each search makes one Routes call plus up to three Places calls. Google gives a monthly free allowance for each API, so personal use should stay at or near $0. Setting a budget alert in Google Cloud is a good idea.
