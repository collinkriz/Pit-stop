// Pit Stop — Netlify function
// Keeps the Google key server-side. Steps:
//   1. Routes API: get the A→B route (time + polyline)
//   2. Places API (New) Text Search with searchAlongRoute: find places along it.
//      Passing routingParameters.origin makes Google return, for every place,
//      two legs: start→place and place→destination. Detour = legs − direct route.
//      That automatically counts weird exits, missing on-ramps, backtracking, etc.

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const MAX_PAGES = 3; // up to 60 results

const secs = (s) => parseInt(String(s || "0").replace("s", ""), 10) || 0;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Decode a Google encoded polyline into [lat, lng] pairs
function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

function milesBetween(a, b) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Straight-line distance from a place to the closest point on the route
function milesOffRoute(pt, routePts) {
  let best = Infinity;
  for (const p of routePts) {
    const d = milesBetween(pt, p);
    if (d < best) best = d;
  }
  return best;
}

const toWaypoint = (v) =>
  v && typeof v === "object" && v.lat != null
    ? { location: { latLng: { latitude: v.lat, longitude: v.lng } } }
    : { address: String(v) };

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) {
    return json({ error: "Missing GOOGLE_MAPS_KEY. Add it in Netlify → Site configuration → Environment variables." }, 500);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const { origin, destination } = body;
  const query = (body.query || "").trim() || "restaurants";
  const queries = (Array.isArray(body.queries) ? body.queries : [query])
    .map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  if (!queries.length) queries.push("restaurants");
  if (!origin || !destination) return json({ error: "Need a start and a destination." }, 400);

  // 1) The base route
  const routeRes = await fetch(ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation",
    },
    body: JSON.stringify({
      origin: toWaypoint(origin),
      destination: toWaypoint(destination),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    }),
  });
  const routeData = await routeRes.json();
  if (!routeRes.ok || !routeData.routes?.length) {
    return json({ error: routeData.error?.message || "Couldn't find a driving route between those places." }, 502);
  }

  const route = routeData.routes[0];
  const baseSecs = secs(route.duration);
  const start = route.legs[0].startLocation.latLng;
  const end = route.legs[route.legs.length - 1].endLocation.latLng;
  const encoded = route.polyline.encodedPolyline;
  const routePts = decodePolyline(encoded);

  // 2) Places along the route, with per-place routing summaries.
  //    Several search terms can run at once (a blank search covers sit-down,
  //    fast food and drive-thrus) and the results are merged.
  const results = [];
  const seen = new Set();
  const pages = queries.length > 1 ? 2 : MAX_PAGES;

  async function runQuery(textQuery) {
    let pageToken;
    for (let page = 0; page < pages; page++) {
      const placesRes = await fetch(PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": [
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.location",
            "places.rating",
            "places.userRatingCount",
            "places.currentOpeningHours.openNow",
            "places.googleMapsUri",
            "places.primaryTypeDisplayName",
            "places.primaryType",
            "places.types",
            "routingSummaries",
            "nextPageToken",
          ].join(","),
        },
        body: JSON.stringify({
          textQuery,
          pageSize: 20,
          ...(pageToken ? { pageToken } : {}),
          searchAlongRouteParameters: { polyline: { encodedPolyline: encoded } },
          routingParameters: {
            origin: { latitude: start.latitude, longitude: start.longitude },
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE",
          },
        }),
      });
      const data = await placesRes.json();
      if (!placesRes.ok) {
        if (page === 0) throw new Error(data.error?.message || "Place search failed.");
        return;
      }

      (data.places || []).forEach((p, idx) => {
        if (seen.has(p.id)) return;
        const legs = data.routingSummaries?.[idx]?.legs || [];
        if (legs.length < 2) return;
        seen.add(p.id);
        const toSecs = secs(legs[0].duration);
        const fromSecs = secs(legs[1].duration);
        const lat = p.location.latitude, lng = p.location.longitude;
        results.push({
          id: p.id,
          name: p.displayName?.text || "Unknown",
          address: p.formattedAddress || "",
          type: p.primaryTypeDisplayName?.text || "",
          primaryType: p.primaryType || "",
          types: p.types || [],
          lat, lng,
          rating: p.rating ?? null,
          ratingCount: p.userRatingCount ?? 0,
          openNow: p.currentOpeningHours?.openNow ?? null,
          mapsUri: p.googleMapsUri || "",
          reachSecs: toSecs,                                     // when you'd hit it
          reachMiles: (legs[0].distanceMeters || 0) / 1609.34,
          detourSecs: Math.max(0, toSecs + fromSecs - baseSecs), // time added to trip
          offRouteMiles: milesOffRoute([lat, lng], routePts),
        });
      });

      pageToken = data.nextPageToken;
      if (!pageToken) return;
    }
  }

  const outcomes = await Promise.allSettled(queries.map(runQuery));
  if (!results.length && outcomes.every((o) => o.status === "rejected")) {
    return json({ error: outcomes[0].reason?.message || "Place search failed." }, 502);
  }

  results.sort((a, b) => a.detourSecs - b.detourSecs);

  return json({
    route: {
      durationSecs: baseSecs,
      miles: (route.distanceMeters || 0) / 1609.34,
      start: { lat: start.latitude, lng: start.longitude },
      end: { lat: end.latitude, lng: end.longitude },
      polyline: encoded,
    },
    query,
    places: results,
  });
};

export const config = { path: "/api/pitstop" };
