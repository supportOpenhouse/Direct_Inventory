import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { lookupCoord, societyCoords } from '../utils/societyCoords.js';
import { cityBoundary } from '../utils/cityBoundary.js';
import { lookupMicro, microMarkets } from '../utils/microMarkets.js';

const NCR_CENTER = [77.2, 28.55]; // [lng, lat]

// Hardcoded city centres so the map can highlight cities with no API.
const CITY_CENTERS = {
  Gurgaon: [28.4595, 77.0266],
  Noida: [28.5355, 77.3910],
  Ghaziabad: [28.6692, 77.4538],
};
const cityCenter = (city) => CITY_CENTERS[city] || null;

// White background, orange roads — vector style over OpenFreeMap tiles (no key).
const ORANGE = '#ea580c';   // markers / area outlines (darker, for contrast)
const ROAD = '#FEBA4F';     // road lines (lighter orange)
const STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#f4f4f5' } },
    {
      id: 'roads', type: 'line', source: 'omt', 'source-layer': 'transportation',
      paint: { 'line-color': ROAD, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 10, 1, 14, 2.4, 18, 7] },
    },
    {
      id: 'roads-major', type: 'line', source: 'omt', 'source-layer': 'transportation',
      filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
      paint: { 'line-color': ROAD, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 10, 2.4, 14, 5, 18, 12] },
    },
    // No OSM text labels — we add our own city labels (see 'city-labels' layer).
  ],
};

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

// Grow a LngLatBounds to include a GeoJSON Polygon/MultiPolygon's coords.
function extendBoundsWithGeometry(bounds, geom) {
  if (!geom) return;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) for (const ring of poly) for (const c of ring) bounds.extend(c);
}

// Geographic circle (radius in metres) as a polygon Feature. [lat,lng] in.
function circleFeature([lat, lng], radiusM, props, steps = 64) {
  const earth = 6378137;
  const dLat = (radiusM / earth) * (180 / Math.PI);
  const dLng = (radiusM / (earth * Math.cos((Math.PI * lat) / 180))) * (180 / Math.PI);
  const ring = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export default function ScopeMap({ cities = [], society = [], micro_market = [], plotAll = false }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);
  const renderRef = useRef(() => {});
  const [note, setNote] = useState('');

  // Latest renderer (captures current props) — called on load + on scope change.
  renderRef.current = async () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    setNote('');
    const socFeats = [];
    const bounds = new maplibregl.LngLatBounds();
    let any = false;
    const extend = ([lat, lng]) => { bounds.extend([lng, lat]); any = true; };

    // Centre the map on the scope city/cities and place our own labels there.
    const cityLabelFeats = [];
    for (const c of cities) {
      const ctr = cityCenter(c);
      if (!ctr) continue;
      extend(ctr);
      cityLabelFeats.push({ type: 'Feature', properties: { name: c }, geometry: { type: 'Point', coordinates: [ctr[1], ctr[0]] } });
    }
    map.getSource('city-labels')?.setData({ type: 'FeatureCollection', features: cityLabelFeats });

    // Societies → markers from the bundled coordinate map (no geocoding). Render
    // these first so they show immediately, independent of the (slower, external)
    // city-boundary fetch below.
    const coords = await societyCoords();
    if (!mapRef.current) return;
    let plotted = 0;
    if (plotAll) {
      // Plot every society we have coordinates for (incl. same-named dupes).
      for (const it of coords.items) {
        socFeats.push({ type: 'Feature', properties: { name: it.name }, geometry: { type: 'Point', coordinates: [it.lng, it.lat] } });
        extend([it.lat, it.lng]);
        plotted += 1;
      }
    } else {
      for (const s of society) {
        const pt = lookupCoord(coords, s, cities);
        if (!pt) continue;
        socFeats.push({ type: 'Feature', properties: { name: s }, geometry: { type: 'Point', coordinates: [pt[1], pt[0]] } });
        extend(pt);
        plotted += 1;
      }
    }
    map.getSource('societies')?.setData({ type: 'FeatureCollection', features: socFeats });
    if (any) map.fitBounds(bounds, { padding: 40, maxZoom: 14, duration: 600 });

    if (plotAll) {
      setNote(`Showing all ${plotted} societies in the data.`);
    } else {
      const missing = society.length - plotted;
      if (society.length && plotted === 0) setNote('None of these societies are in the coordinates file yet.');
      else if (missing > 0) setNote(`${plotted} of ${society.length} societies located (${missing} not in the coordinates file).`);
    }

    // Micro-markets → yellow dots (centres, always) + convex-hull borders
    // (fade in on zoom). plotAll shows every micro-market we have.
    const mmData = await microMarkets();
    if (!mapRef.current) return;
    const mmItems = plotAll ? mmData.items : micro_market.map((m) => lookupMicro(mmData, m)).filter(Boolean);
    const mmDots = [];
    for (const it of mmItems) {
      mmDots.push({ type: 'Feature', properties: { name: it.name }, geometry: { type: 'Point', coordinates: [it.center[1], it.center[0]] } });
      extend(it.center);
    }
    map.getSource('mm-dots')?.setData({ type: 'FeatureCollection', features: mmDots });

    // City boundary → shade + outline the scope city (real OSM polygon). Fetched
    // after societies so a slow/missing boundary never blocks the pins.
    // 'Noida' covers Greater Noida too (we fold it), so shade both.
    const cityNames = [];
    for (const c of cities) {
      cityNames.push(c);
      if (c === 'Noida') cityNames.push('Greater Noida');
    }
    const cityFeats = [];
    for (const name of cityNames) {
      const geom = await cityBoundary(name);
      if (!mapRef.current) return;
      if (geom) cityFeats.push({ type: 'Feature', properties: { name }, geometry: geom });
    }
    map.getSource('cities')?.setData({ type: 'FeatureCollection', features: cityFeats });

    // Re-fit to include the whole city boundary (so a city with no/few societies
    // shows its full border instead of zooming to the centre point).
    if (cityFeats.length) {
      for (const f of cityFeats) extendBoundsWithGeometry(bounds, f.geometry);
      if (any) map.fitBounds(bounds, { padding: 40, maxZoom: 14, duration: 600 });
    }
  };

  // Init map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return undefined;
    const map = new maplibregl.Map({ container: elRef.current, style: STYLE, center: NCR_CENTER, zoom: 9, attributionControl: true });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource('cities', { type: 'geojson', data: emptyFC() });
      map.addSource('mm-dots', { type: 'geojson', data: emptyFC() });
      map.addSource('societies', { type: 'geojson', data: emptyFC() });
      // City boundary (only the scope city): shade + outline, drawn underneath.
      map.addLayer({ id: 'city-fill', type: 'fill', source: 'cities', paint: { 'fill-color': '#fb923c', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'city-line', type: 'line', source: 'cities', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ea580c', 'line-width': 2.5, 'line-dasharray': [0, 2.5] } });
      map.addLayer({ id: 'soc', type: 'circle', source: 'societies', paint: { 'circle-radius': 6, 'circle-color': ORANGE, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      // Micro-market marks — yellow dots (same as societies).
      map.addLayer({ id: 'mm-dots', type: 'circle', source: 'mm-dots', paint: { 'circle-radius': 6, 'circle-color': '#eab308', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      // Our own city labels (replace the removed OSM place/road labels).
      map.addSource('city-labels', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'city-labels', type: 'symbol', source: 'city-labels',
        layout: { 'text-field': ['get', 'name'], 'text-size': 15, 'text-font': ['Noto Sans Bold'], 'text-anchor': 'center' },
        paint: { 'text-color': '#111111', 'text-halo-color': '#ffffff', 'text-halo-width': 2.4 },
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      const showName = (e) => {
        const f = e.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = 'pointer';
        const c = f.geometry.type === 'Point' ? f.geometry.coordinates : e.lngLat;
        popup.setLngLat(c).setText(f.properties.name).addTo(map);
      };
      const hide = () => { map.getCanvas().style.cursor = ''; popup.remove(); };
      map.on('mouseenter', 'soc', showName);
      map.on('mouseleave', 'soc', hide);
      map.on('mouseenter', 'mm-dots', showName);
      map.on('mouseleave', 'mm-dots', hide);

      loadedRef.current = true;
      renderRef.current();
    });
    return () => { map.remove(); mapRef.current = null; loadedRef.current = false; };
  }, []);

  // Re-render layers when the scope changes.
  useEffect(() => { if (loadedRef.current) renderRef.current(); /* eslint-disable-next-line */ }, [JSON.stringify(cities), JSON.stringify(society), JSON.stringify(micro_market), plotAll]);

  return (
    <div className="scope-map-wrap">
      <div ref={elRef} className="scope-map" />
      <div className="scope-map-legend">
        <span><i className="lg-dot lg-society" /> Society</span>
        <span><i className="lg-dot lg-mm" /> Micro-market</span>
        <span><i className="lg-area lg-city" /> City</span>
      </div>
      {note && <div className="scope-map-note">{note}</div>}
    </div>
  );
}
