// Viewer for the project: places model.glb on a 3D map of its surroundings.
import { config } from "./config.js";

const params = new URLSearchParams(location.search);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

if (isLocal && !config.ionToken) {
  // Served by scripts/dev_server.py from .env; this file doesn't exist on the published site.
  config.ionToken = (await import("./config.local.js")).ionToken;
}
// ?map= is what the page's own switch uses. ?context= is the same thing, for tests on the local server only.
const MAPS = ["google", "geoportal"];
const asked = (isLocal && params.get("context")) || params.get("map");
const contextName = MAPS.includes(asked) ? asked : isLocal ? config.localContext : config.context;
const useGoogle = contextName === "google";
const isSmallScreen = matchMedia("(max-width: 640px)").matches;

const [site, siteTrees] = await Promise.all([
  fetch("./site.json").then((r) => r.json()),
  // The trees standing where the project paves, from scripts/gugik_surroundings.py. The page works without them.
  fetch("./site_trees.json")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null),
]);
const statusEl = document.getElementById("status");
const setStatus = (text) => {
  statusEl.textContent = text || "";
  statusEl.hidden = !text;
};

Cesium.Ion.defaultAccessToken = config.ionToken;

// --- local east-north-up frame at the reference point ------------------------------
const lonDeg = site.reference.lon;
const latDeg = site.reference.lat;

function enuMatrix(height) {
  const origin = Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, height);
  const matrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const { east, north, up } = config.offset;
  const shift = new Cesium.Cartesian3(east, north, up);
  return Cesium.Matrix4.multiplyByTranslation(matrix, shift, new Cesium.Matrix4());
}

function localToWorld(matrix, x, y, z) {
  return Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
}

// Ellipsoid height of the ground here, in metres. Good to a few centimetres, so everything starts from it, and the
// measured height replaces it once the map is on screen.
const FALLBACK_HEIGHT = 114.5;
const PLAUSIBLE_RANGE = 30;
let originHeight = FALLBACK_HEIGHT;
let heightSamples = [];
let modelMatrix = enuMatrix(originHeight);

// --- the Geoportal map's ground and photo ---------------------------------------------------
// The survey's spot heights, interpolated exactly as blender/terrain.py does for the model.
function groundAt(x, y) {
  let total = 0;
  let weights = 0;
  for (const spot of site.groundSpots) {
    const d2 = (x - spot.x) ** 2 + (y - spot.y) ** 2;
    if (d2 < 1e-6) return spot.z;
    total += spot.z / d2;
    weights += 1 / d2;
  }
  return total / weights;
}

// Lower than the model's surfaces, or the photo would show through them: the ground rises up to 3 cm above the paving's
// flat triangles, and coarse terrain tiles add to that. Depth testing then hides the skirts below the model's surfaces.
const GROUND_BELOW_SURVEY_M = 0.1;

function surveyedGround() {
  const size = 32;
  const tiling = new Cesium.GeographicTilingScheme();
  const { radii } = Cesium.Ellipsoid.WGS84;
  const lat0 = Cesium.Math.toRadians(latDeg);
  const lon0 = Cesium.Math.toRadians(lonDeg);
  const e2 = 1 - (radii.z / radii.x) ** 2;
  const w = Math.sqrt(1 - e2 * Math.sin(lat0) ** 2);
  const metresEast = (radii.x / w) * Math.cos(lat0); // per radian of longitude
  const metresNorth = (radii.x * (1 - e2)) / w ** 3; // per radian of latitude
  return new Cesium.CustomHeightmapTerrainProvider({
    width: size,
    height: size,
    tilingScheme: tiling,
    callback: (tileX, tileY, level) => {
      const r = tiling.tileXYToRectangle(tileX, tileY, level);
      const heights = new Float32Array(size * size);
      for (let row = 0; row < size; row++) {
        const y = (r.north - (row / (size - 1)) * (r.north - r.south) - lat0) * metresNorth;
        for (let col = 0; col < size; col++) {
          const x = (r.west + (col / (size - 1)) * (r.east - r.west) - lon0) * metresEast;
          heights[row * size + col] = FALLBACK_HEIGHT + groundAt(x, y) - GROUND_BELOW_SURVEY_M;
        }
      }
      return heights;
    },
  });
}

// The first imagery layer gets its edge pixels stretched over the rest of the globe, so that's a plain colour, and the
// photo goes on top of it as a normal layer, which just stops at its edge.
const HAZE_CSS = "#c9d2cb";
function plainHaze() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context2d = canvas.getContext("2d");
  context2d.fillStyle = HAZE_CSS;
  context2d.fillRect(0, 0, 1, 1);
  return new Cesium.SingleTileImageryProvider({ url: canvas.toDataURL("image/png"), tileWidth: 1, tileHeight: 1 });
}

// The aerial photo, only inside the map's limit: past it the plain colour shows, as the floor does on the Google map.
// Two services: the WMTS serves ready-made tiles, about 0.1 s each, but has nothing finer than level 12 (about 1.3 m a
// pixel) here. The WMS draws each tile on request, up to 2.7 s, but goes down to a few centimetres. So the WMTS gives
// a quick first layer and the WMS sharpens it, as the Google map does.
const GEOPORTAL = "https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO";
const COARSE_PHOTO_LEVELS = 12;
// Geoportal's terms: state the source. One credit for the photo, buildings and trees, so it shows once.
const GUGIK_CREDIT = new Cesium.Credit("Ortofotomapa, budynki i drzewa 3D: GUGiK, geoportal.gov.pl", true);
let coarsePhotoLoaded; // resolves when the coarse photo has nothing left to fetch
const coarsePhotoIdle = new Promise((resolve) => (coarsePhotoLoaded = resolve));

function orthophotos() {
  const { centre, radius } = site.mapLimit;
  const corner = (sign) => Cesium.Cartographic.fromCartesian(localToWorld(modelMatrix, centre[0] + sign * radius, centre[1] + sign * radius, 0));
  const rectangle = Cesium.Rectangle.fromCartographicArray([corner(-1), corner(1)]);
  // The WMTS's EPSG:4326 grid: top-left corner 56 N 12 E, square 512 px tiles that halve at each level. Level 0 is
  // 3.0238155714402866e7 (its scale denominator) x 0.28 mm a pixel x 512 pixels, in degrees.
  const levelZero = (3.0238155714402866e7 * 0.00028 * 512) / ((2 * Math.PI * 6378137) / 360);
  const coarse = new Cesium.WebMapTileServiceImageryProvider({
    url: `${GEOPORTAL}/WMTS/HighResolution`,
    layer: "ORTOFOTOMAPA",
    style: "default",
    format: "image/jpeg",
    tileMatrixSetID: "EPSG:4326",
    tileMatrixLabels: Array.from({ length: 17 }, (_, level) => `EPSG:4326:${level}`),
    tilingScheme: new Cesium.GeographicTilingScheme({
      rectangle: Cesium.Rectangle.fromDegrees(12, 56 - levelZero, 12 + levelZero, 56),
      numberOfLevelZeroTilesX: 1,
      numberOfLevelZeroTilesY: 1,
    }),
    tileWidth: 512,
    tileHeight: 512,
    rectangle,
    maximumLevel: COARSE_PHOTO_LEVELS,
    credit: GUGIK_CREDIT,
  });
  // Count what the coarse layer still has in flight, so the map can be shown as soon as it's all there. Not after the
  // first few tiles: those are the broad overview levels, fetched before the detailed ones are even asked for.
  const requestImage = coarse.requestImage.bind(coarse);
  let pending = 0;
  let deepest = 0;
  coarse.requestImage = (x, y, level, request) => {
    const promise = requestImage(x, y, level, request);
    if (!promise) return promise; // throttled: Cesium asks again later
    pending++;
    return promise.finally(() => {
      deepest = Math.max(deepest, level);
      if (--pending === 0 && deepest >= COARSE_PHOTO_LEVELS - 1) coarsePhotoLoaded();
    });
  };
  const fine = new Cesium.WebMapServiceImageryProvider({
    url: `${GEOPORTAL}/WMS/HighResolution`,
    layers: "Raster",
    parameters: { format: "image/jpeg", transparent: false },
    rectangle,
    minimumLevel: COARSE_PHOTO_LEVELS + 1,
    maximumLevel: 21,
    enablePickFeatures: false,
    credit: GUGIK_CREDIT,
  });
  return [coarse, fine];
}


const viewer = new Cesium.Viewer("map", {
  geocoder: false, // also means the token needs no "geocode" scope
  baseLayerPicker: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  shadows: true,
  terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
  // The Google tiles replace the globe entirely. The Geoportal map lays the aerial photo on the surveyed ground.
  globe: useGoogle ? false : undefined,
  baseLayer: useGoogle ? false : new Cesium.ImageryLayer(plainHaze()),
  terrainProvider: useGoogle ? undefined : surveyedGround(),
});
const { scene, camera } = viewer;

Object.assign(viewer.shadowMap, {
  softShadows: true,
  size: isSmallScreen ? 2048 : 4096,
  maximumDistance: 800,
  darkness: 0.55,
});
// The Google tiles have no normals, so Cesium's usual fix for speckled self-shadowing doesn't apply to them.
// This private setting is the remaining control; the CesiumJS version is pinned in index.html.
viewer.shadowMap._primitiveBias.depthBias = config.shadowDepthBias;
scene.skyAtmosphere.show = true;
scene.skyBox.show = false; // no stars: the sky here doesn't follow the clock anyway, and that's six fewer images to download
// Zooming out further than this would show the map as a slab with edges.
scene.screenSpaceCameraController.maximumZoomDistance = 700;

// The map stops at site.mapLimit. Below the horizon the sky is black, so past the map's edge a plain colour shows instead:
// the globe's on the Geoportal map, and on the Google map, which has no globe, a floor a little below the ground.
const HAZE_COLOR = Cesium.Color.fromCssColorString(HAZE_CSS);
const HAZE_FLOOR_BELOW_GROUND_M = 8;
if (!useGoogle) {
  for (const provider of orthophotos()) scene.imageryLayers.addImageryProvider(provider);
  scene.globe.baseColor = HAZE_COLOR;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.depthTestAgainstTerrain = true;
} else {
  scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.EllipseGeometry({
          center: Cesium.Cartesian3.fromDegrees(lonDeg, latDeg),
          semiMajorAxis: 100000,
          semiMinorAxis: 100000,
          height: FALLBACK_HEIGHT - HAZE_FLOOR_BELOW_GROUND_M,
          vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(HAZE_COLOR) },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
    }),
  );
}

// --- startup: nothing above this point waits on the network ------------------------------
// The viewer opens on the whole Earth, so the camera has to be over the site before the first frame is drawn.
performance.mark("camera over the site");
const startup = { highestCamera: 0 };
const stopWatchingCamera = scene.preRender.addEventListener(() => {
  startup.highestCamera = Math.max(startup.highestCamera, camera.positionCartographic.height);
});

// --- cameras ----------------------------------------------------------------------------
function cameraTarget(view) {
  const eye = localToWorld(modelMatrix, ...view.eye);
  const target = localToWorld(modelMatrix, ...view.target);
  const direction = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(target, eye, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(eye, new Cesium.Cartesian3());
  const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const trueUp = Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3());
  return { destination: eye, orientation: { direction, up: trueUp } };
}

// Views marked "orbit" turn around their target. With the camera in a frame centred on the target, Cesium's own
// controls orbit that point: drag or one finger to turn, wheel or pinch to zoom.
const MIN_ORBIT_ELEVATION = Cesium.Math.toRadians(15); // keeps the camera above the neighbouring roofs at the preset distance
let orbiting = false;

function startOrbit(view) {
  camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(localToWorld(modelMatrix, ...view.target)));
  camera.constrainedAxis = Cesium.Cartesian3.UNIT_Z;
  orbiting = true;
  setControls();
}

function stopOrbit() {
  if (!orbiting) return;
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  camera.constrainedAxis = undefined;
  orbiting = false;
  setControls();
}

// Collision is off, so nothing else stops the camera going down through the ground.
scene.preRender.addEventListener(() => {
  if (!orbiting) return;
  const elevation = Math.asin(camera.position.z / Cesium.Cartesian3.magnitude(camera.position));
  // rotateDown raises the eye: Cesium names these after the way the view turns, not the way the eye moves.
  if (elevation < MIN_ORBIT_ELEVATION) camera.rotateDown(MIN_ORBIT_ELEVATION - elevation);
});

// --- mouse and touch controls --------------------------------------------------------------
// In every view a drag moves the map, a drag with Ctrl (or Cmd) turns around the point under the cursor, a drag with
// Shift pans, and the wheel zooms. In an orbit view a plain drag, or one with Ctrl, turns around the target instead, and
// Shift leaves the orbit to pan. On a touch screen one finger drags and two pinch, twist and tilt.
const { CameraEventType, KeyboardEventModifier } = Cesium;
const controller = scene.screenSpaceCameraController;
controller.lookEventTypes = undefined; // Cesium's Shift-drag turns the camera where it stands; here Shift pans
const DRAG_WITH_CTRL = [
  { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
  { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const isTouch = matchMedia("(pointer: coarse)").matches;
const controlsHint = document.getElementById("controls-hint");
// Turning on a phone was too fast (Jarek, 2026-11-06): 2.5 times slower on touch screens. Every turn (the orbit, and the
// two-finger twist and tilt) goes through Cesium's rotate3D, whose rate is (distance - 1) capped at _maximumRotateRate,
// 1.77. Beyond about 3 m from the centre of the turn, which is always here, the cap sets the speed. It's private, so
// recheck it on any Cesium upgrade.
const TOUCH_TURN_SLOWDOWN = 2.5;
if (isTouch) controller._maximumRotateRate /= TOUCH_TURN_SLOWDOWN;

function setControls() {
  if (orbiting) {
    // Cesium's own turn ("tilt") does nothing in the orbit's frame, so Ctrl joins the plain drag, which orbits there.
    controller.rotateEventTypes = [CameraEventType.LEFT_DRAG, ...DRAG_WITH_CTRL];
    controller.tiltEventTypes = [CameraEventType.MIDDLE_DRAG, CameraEventType.PINCH];
  } else {
    // "rotate" is Cesium's name for dragging the globe, which near the ground pans the point under the cursor.
    controller.rotateEventTypes = [CameraEventType.LEFT_DRAG, { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT }];
    controller.tiltEventTypes = [CameraEventType.MIDDLE_DRAG, CameraEventType.PINCH, ...DRAG_WITH_CTRL];
  }
  const turnKey = isMac ? "Ctrl lub ⌘" : "Ctrl";
  if (isTouch) {
    controlsHint.textContent = orbiting
      ? "Jednym palcem obrócisz widok, dwoma go przybliżysz."
      : "Jednym palcem przesuniesz widok, dwoma go przybliżysz i obrócisz.";
  } else {
    controlsHint.textContent = orbiting
      ? "Przeciągnij, żeby obrócić widok. Z wciśniętym Shift przesuniesz go, a kółkiem przybliżysz."
      : `Przeciągnij, żeby przesunąć widok. Z wciśniętym ${turnKey} obrócisz go, a kółkiem przybliżysz.`;
  }
}
setControls();

// Cesium reads only Shift, Ctrl and Alt off each event, so Cmd is passed on as Ctrl: on a Mac, Ctrl with a click is a
// right click. Capturing on the window runs before Cesium's listeners, which are on the canvas and the document.
for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "wheel"]) {
  addEventListener(
    type,
    (event) => {
      if (event.metaKey && !event.ctrlKey) Object.defineProperty(event, "ctrlKey", { value: true });
      // Shift pans, which the orbit's frame can't do, so leave the orbit before Cesium sees the press.
      if (event.shiftKey && orbiting && (type === "pointerdown" || type === "mousedown") && event.target === scene.canvas) stopOrbit();
    },
    { capture: true },
  );
}

// --- views and the way back to one --------------------------------------------------------------
const cameraButtons = document.getElementById("cameras");
const resetButton = document.getElementById("reset-view");
let activeView = config.initialCamera;
let flight = 0; // the flight under way, if any: starting one cancels the last, whose callback must not count
let flying = false;

function markActive(view) {
  activeView = view.id;
  for (const b of cameraButtons.children) b.classList.toggle("active", b.dataset.id === view.id);
  resetButton.title = `Wróć do widoku „${view.label}”`;
}

function goTo(id, duration = 1.6) {
  const view = site.cameras.find((c) => c.id === id);
  markActive(view);
  stopOrbit();
  const thisFlight = ++flight;
  flying = true;
  const landed = () => {
    if (thisFlight === flight) flying = false;
  };
  camera.flyTo({
    ...cameraTarget(view),
    duration,
    complete: () => {
      landed();
      if (view.orbit) startOrbit(view);
    },
    cancel: landed,
  });
}

// The button shows whenever the camera is away from the chosen view, whatever moved it: a drag, the wheel, or a switch of
// maps from a moved camera. The tolerance is well above the centimetres the Google map's height measurement shifts things.
const AWAY_M = 0.3;
const AWAY_RAD = Cesium.Math.toRadians(0.5);
scene.postRender.addEventListener(() => {
  const view = site.cameras.find((c) => c.id === activeView);
  let away = false;
  if (view && !flying) {
    const preset = cameraTarget(view);
    away =
      Cesium.Cartesian3.distance(camera.positionWC, preset.destination) > AWAY_M ||
      Cesium.Cartesian3.angleBetween(camera.directionWC, preset.orientation.direction) > AWAY_RAD;
  }
  if (resetButton.hidden === away) resetButton.hidden = !away;
});
resetButton.addEventListener("click", () => goTo(activeView));
for (const view of site.cameras) {
  const button = document.createElement("button");
  button.textContent = view.label;
  button.dataset.id = view.id;
  button.addEventListener("click", () => goTo(view.id));
  cameraButtons.append(button);
}
goTo(config.initialCamera, 0);

// --- switching maps -----------------------------------------------------------------------------
// A switch reloads the page with the other map, so each map starts clean and neither pays for the other. The camera, date,
// time and project checkbox come along in the address, which is cleaned up again once they're applied.
function readSwitchState() {
  try {
    const state = JSON.parse(params.get("state"));
    const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
    if (!isPoint(state?.eye) || !isPoint(state?.direction) || !isPoint(state?.up)) return null;
    return state;
  } catch {
    return null;
  }
}
const switchState = readSwitchState();

if (switchState) {
  const asWorldVector = (v) => Cesium.Matrix4.multiplyByPointAsVector(modelMatrix, new Cesium.Cartesian3(...v), new Cesium.Cartesian3());
  const view = site.cameras.find((c) => c.id === switchState.view);
  stopOrbit();
  camera.setView({
    destination: localToWorld(modelMatrix, ...switchState.eye),
    orientation: { direction: asWorldVector(switchState.direction), up: asWorldVector(switchState.up) },
  });
  if (view) {
    markActive(view);
    if (view.orbit && switchState.orbiting) startOrbit(view);
  }
}
if (params.has("state")) {
  const clean = new URL(location.href);
  clean.searchParams.delete("state");
  history.replaceState(null, "", clean);
}

function switchMap(name) {
  const toLocal = Cesium.Matrix4.inverseTransformation(modelMatrix, new Cesium.Matrix4());
  const round = (c) => [c.x, c.y, c.z].map((n) => Number(n.toFixed(4)));
  const asLocalVector = (v) => round(Cesium.Matrix4.multiplyByPointAsVector(toLocal, v, new Cesium.Cartesian3()));
  const url = new URL(location.href);
  url.searchParams.delete("context");
  url.searchParams.set("map", name);
  url.searchParams.set(
    "state",
    JSON.stringify({
      eye: round(Cesium.Matrix4.multiplyByPoint(toLocal, camera.positionWC, new Cesium.Cartesian3())),
      direction: asLocalVector(camera.directionWC),
      up: asLocalVector(camera.upWC),
      view: activeView,
      orbiting,
      date: document.getElementById("date").value.slice(5),
      time: Number(document.getElementById("time").value),
      project: document.getElementById("project").checked,
    }),
  );
  location.href = url;
}
for (const button of document.querySelectorAll("#maps button")) {
  button.classList.toggle("active", button.dataset.map === contextName);
  if (button.dataset.map !== contextName) button.addEventListener("click", () => switchMap(button.dataset.map));
}
document.getElementById(`map-note-${contextName}`).hidden = false;

// When the Google map fails, say with a rejected token or after too many loads too quickly, offer the Geoportal map,
// which needs neither. For a failure to open the map, the message comes from the handler in index.html, which runs first
// and replaces the status text, button included, on each error. For tiles refused later, see reportRefusedTiles.
let mapFailed = false; // keeps the message up once the loading message would otherwise be cleared
function offerGeoportal() {
  const button = document.createElement("button");
  button.id = "fallback-map";
  button.textContent = "Otwórz mapę Geoportal";
  button.addEventListener("click", () => switchMap("geoportal"));
  statusEl.append(" ", button);
}
if (useGoogle) {
  for (const type of ["error", "unhandledrejection"]) addEventListener(type, offerGeoportal);
}

// --- date and time ------------------------------------------------------------------------
const dateInput = document.getElementById("date");
const timeInput = document.getElementById("time");
const timeLabel = document.getElementById("time-label");
const sunNote = document.getElementById("sun-note");
const dateButtons = document.querySelectorAll("#dates button");
const sunSummary = document.getElementById("sun-summary"); // what the folded section is set to

// UTC offset in minutes of Warsaw time on a given calendar day (handles summer time).
function warsawOffsetMinutes(utcGuess) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" }).formatToParts(utcGuess);
  const match = parts.find((p) => p.type === "timeZoneName").value.match(/GMT([+-]\d+)?/);
  return match && match[1] ? Number(match[1]) * 60 : 0;
}

function applyTime() {
  const [year, month, day] = dateInput.value.split("-").map(Number);
  const minutes = Number(timeInput.value);
  const guess = new Date(Date.UTC(year, month - 1, day, 12));
  const utc = Date.UTC(year, month - 1, day, 0, minutes - warsawOffsetMinutes(guess));
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(utc));
  viewer.clock.shouldAnimate = false;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  timeLabel.textContent = `${hh}:${mm}`;
  sunNote.hidden = sunIsUp(viewer.clock.currentTime);
  let preset = null;
  for (const b of dateButtons) {
    b.classList.toggle("active", dateInput.value.endsWith(b.dataset.date));
    if (dateInput.value.endsWith(b.dataset.date)) preset = b.textContent.toLowerCase();
  }
  sunSummary.textContent = `${preset ?? `${day}.${String(month).padStart(2, "0")}`}, ${hh}:${mm}`;
  scene.requestRender();
}

function sunIsUp(time) {
  const toFixed = Cesium.Transforms.computeIcrfToFixedMatrix(time) ?? Cesium.Transforms.computeTemeToPseudoFixedMatrix(time);
  const inertial = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
  const sun = Cesium.Matrix3.multiplyByVector(toFixed, inertial, new Cesium.Cartesian3());
  const here = Cesium.Cartesian3.fromDegrees(lonDeg, latDeg);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(here, new Cesium.Cartesian3());
  return Cesium.Cartesian3.dot(Cesium.Cartesian3.normalize(sun, sun), up) > 0;
}

const year = new Date().getFullYear();
// Summer solstice at 15:00 (Jarek's choice, 2026-11-06), unless the map switch carried a setting over.
dateInput.value = `${year}-${/^\d\d-\d\d$/.test(switchState?.date) ? switchState.date : "06-21"}`;
timeInput.value = Number.isFinite(switchState?.time) ? switchState.time : 15 * 60;
for (const b of dateButtons) {
  b.addEventListener("click", () => {
    dateInput.value = `${year}-${b.dataset.date}`;
    applyTime();
  });
}
dateInput.addEventListener("input", applyTime);
timeInput.addEventListener("input", applyTime);
applyTime();

// --- map context ----------------------------------------------------------------------
const clippingSupported = Cesium.ClippingPolygonCollection.isSupported(scene);

// Keep only the map around the site. Planes rather than a clipping polygon, because Cesium skips tiles that are wholly
// outside a plane without downloading them, while a polygon only hides them once they're loaded.
function mapLimitPlanes(tileset) {
  const { centre, radius, sides } = site.mapLimit;
  const planes = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i * 2 * Math.PI) / sides;
    planes.push(new Cesium.ClippingPlane(new Cesium.Cartesian3(-Math.cos(angle), -Math.sin(angle), 0), radius));
  }
  const atSite = Cesium.Transforms.eastNorthUpToFixedFrame(localToWorld(modelMatrix, centre[0], centre[1], 0));
  // Cesium applies planes relative to this tileset's own origin. A private property, but the version is pinned in index.html.
  const fromOrigin = Cesium.Matrix4.inverseTransformation(tileset.clippingPlanesOriginMatrix, new Cesium.Matrix4());
  return new Cesium.ClippingPlaneCollection({
    planes,
    unionClippingRegions: true, // clip what's outside any plane, which leaves the inside of the octagon
    modelMatrix: Cesium.Matrix4.multiply(fromOrigin, atSite, new Cesium.Matrix4()),
  });
}

// The Google map's cuts under the project's surfaces, which "Pokaż projekt" adds and removes. The cuts under the tężnia's
// paving stay: the tężnia is already there, and the map is older.
const projectCuts = [];

// Opens the tileset: Cesium ion's endpoint, then Google's root tile. Nothing more is fetched until it's added to the scene.
async function openGoogleTiles() {
  const tileset = await Cesium.createGooglePhotorealistic3DTileset(
    { onlyUsingWithGoogleGeocoder: true },
    {
      maximumScreenSpaceError: isSmallScreen ? config.phoneScreenSpaceError : 16,
      // On by default for these tiles. Before detail loads it reads heights off the coarse mesh and lifts a
      // street-level camera to about 20 m, for good. Without it you can zoom through the ground, but the view
      // buttons bring you back.
      enableCollision: false,
      // Go straight to the tiles this view needs, without every coarser level on the way down. On a phone on 4G
      // this halves the download and the time until the map is sharp, and the final picture is the same.
      skipLevelOfDetail: true,
    },
  );
  // Photogrammetry trees are hollow shells with no ground inside. Where the clipping below cuts one open,
  // culled back faces would show a black void; drawing them shows the inside of the crown instead.
  tileset.backFaceCulling = false;

  // Cut the old mesh where the model's surfaces stand. The polygons lie on the ellipsoid, so the height doesn't affect them.
  if (clippingSupported && site.clipPolygons.length > 0) {
    const cuts = site.clipPolygons.map((c) => {
      const cut = new Cesium.ClippingPolygon({ positions: c.polygon.map(([x, y]) => localToWorld(modelMatrix, x, y, 0)) });
      if (!c.existing) projectCuts.push(cut);
      return cut;
    });
    tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons: cuts });
  }
  tileset.clippingPlanes = mapLimitPlanes(tileset);
  return tileset;
}

// --- marked places: their shapes and highlight ---------------------------------------------------------------------
// The places on the site plan's legend, and a "?" over the GUGiK trees standing on the project's paving (viewer.markers in
// the spec, resolved by scripts/spec_to_site.py). Each has a pin. Hovering the pin or the object lights the object up,
// and clicking either opens its popup. Shapes are in local metres: prisms, drapes, cylinders and ellipsoids. Each
// marker tints its own layer: the model's objects in model.glb, the map's in surroundings.glb or, on the Google map, in
// the photogrammetry.
const MARK_COLOUR = Cesium.Color.fromCssColorString("#ffd54a");

// The trees are GUGiK's crowns and trunks, as surroundings.glb draws them (site_trees.json). On the Geoportal map the
// crowns are lumpy, reaching a little past their radii. Google's photogrammetry trees match GUGiK's only roughly, so more
// there, with the trunks starting clear of the ground, which would be tinted too.
function withSiteTrees(marker) {
  if (!siteTrees?.crowns?.length) return null;
  const scale = useGoogle ? 1.2 : siteTrees.crownLumps;
  const pad = useGoogle ? 0.6 : 0.15;
  const xs = siteTrees.crowns.map((c) => c.centre[0]);
  const ys = siteTrees.crowns.map((c) => c.centre[1]);
  const top = Math.max(...siteTrees.crowns.map((c) => c.centre[2] + c.radii[2]));
  return {
    ...marker,
    shapes: [
      ...siteTrees.crowns.map((c) => ({ type: "ellipsoid", centre: c.centre, radii: c.radii.map((r) => r * scale + pad) })),
      ...siteTrees.trunks.map((t) => ({ type: "cylinder", xy: t.xy, z: [t.z[0] + (useGoogle ? 1 : 0), t.z[1]], radius: t.radius * 1.3 + pad })),
    ],
    pin: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, top + 1], // a metre over the highest crown
  };
}
const markers = site.markers
  .map((m) => (m.shapes.some((s) => s.type === "site_trees") ? withSiteTrees(m) : m))
  .filter(Boolean)
  .map((m, index) => ({ ...m, index }));

// Prisms and drapes have an outline and maybe holes. A drape is a surface laid on the slope: its z range is above the
// ground under each point, and the shader lights only its faces turned up. The rest have a fixed z range.
const ringsOf = (s) => [s.polygon, ...(s.holes ?? [])];

// `slack` widens the z ranges, for points read from the depth under the pointer, which are a few centimetres out.
function inShape(s, p, slack = 0) {
  if (s.type === "ellipsoid") {
    const [c, r] = [s.centre, s.radii];
    return ((p.x - c[0]) / r[0]) ** 2 + ((p.y - c[1]) / r[1]) ** 2 + ((p.z - c[2]) / r[2]) ** 2 <= 1;
  }
  const ground = s.type === "drape" ? groundAt(p.x, p.y) : 0;
  const [z0, z1] = s.type === "drape" ? [ground + s.dz[0], ground + s.dz[1]] : s.z;
  if (p.z < z0 - slack || p.z > z1 + slack) return false;
  if (s.type === "cylinder") return (p.x - s.xy[0]) ** 2 + (p.y - s.xy[1]) ** 2 <= s.radius ** 2;
  let inside = false; // count the edges crossed on the way out, the holes' too
  for (const ring of ringsOf(s)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [[xi, yi], [xj, yj]] = [ring[i], ring[j]];
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function shapeVolume(s) {
  if (s.type === "ellipsoid") return (4 / 3) * Math.PI * s.radii[0] * s.radii[1] * s.radii[2];
  const height = s.type === "drape" ? s.dz[1] - s.dz[0] : s.z[1] - s.z[0];
  if (s.type === "cylinder") return Math.PI * s.radius ** 2 * height;
  const ringArea = (ring) => {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(area) / 2;
  };
  return (ringArea(s.polygon) - (s.holes ?? []).reduce((sum, hole) => sum + ringArea(hole), 0)) * height;
}
// Where shapes overlap, the smaller object takes the pointer: the column, say, not the paving round it.
const byPriority = [...markers].sort((a, b) => a.shapes.reduce((v, s) => v + shapeVolume(s), 0) - b.shapes.reduce((v, s) => v + shapeVolume(s), 0));

// The same tests in GLSL, one function per shape, with the numbers written in. p is the point and n its face's normal,
// both in local metres.
const glslNumber = (n) => n.toFixed(4);
function shapeGLSL(s, name) {
  const f = glslNumber;
  const g = (n) => (/[.e]/.test(String(n.toPrecision(9))) ? n.toPrecision(9) : `${n.toPrecision(9)}.0`);
  const v3 = (a) => `vec3(${a.map(f).join(", ")})`;
  if (s.type === "ellipsoid") return `bool ${name}(vec3 p, vec3 n) { vec3 q = (p - ${v3(s.centre)}) / ${v3(s.radii)}; return dot(q, q) <= 1.0; }`;
  if (s.type === "cylinder") {
    return `bool ${name}(vec3 p, vec3 n) { if (p.z < ${f(s.z[0])} || p.z > ${f(s.z[1])}) return false; return distance(p.xy, vec2(${f(s.xy[0])}, ${f(s.xy[1])})) <= ${f(s.radius)}; }`;
  }
  const xs = s.polygon.map((q) => q[0]);
  const ys = s.polygon.map((q) => q[1]);
  const box = `if (p.x < ${f(Math.min(...xs))} || p.x > ${f(Math.max(...xs))} || p.y < ${f(Math.min(...ys))} || p.y > ${f(Math.max(...ys))}) return false;`;
  const edges = ringsOf(s).flatMap((ring) =>
    ring.map(([xi, yi], i) => {
      const [xj, yj] = ring[(i + ring.length - 1) % ring.length];
      if (yi === yj) return ""; // an edge along x is never crossed
      return `if ((${f(yi)} > p.y) != (${f(yj)} > p.y) && p.x < ${g((xj - xi) / (yj - yi))} * (p.y - ${f(yi)}) + ${f(xi)}) c = !c;`;
    }),
  );
  const inside = `${box} bool c = false; ${edges.join(" ")}`;
  if (s.type === "drape") {
    // Faces turned up only, within 37° of level, and the ground last, as it's the dearest test.
    return `bool ${name}(vec3 p, vec3 n) { if (n.z < 0.8) return false; ${inside} if (!c) return false; float g = groundAt(p.xy); return p.z >= g + ${f(s.dz[0])} && p.z <= g + ${f(s.dz[1])}; }`;
  }
  return `bool ${name}(vec3 p, vec3 n) { if (p.z < ${f(s.z[0])} || p.z > ${f(s.z[1])}) return false; ${inside} return c; }`;
}

// groundAt() in GLSL, for drapes: the same inverse-distance interpolation through the survey's spot heights.
function groundGLSL() {
  const f = glslNumber;
  const terms = site.groundSpots.map((s) => `d = p - vec2(${f(s.x)}, ${f(s.y)}); w = 1.0 / max(dot(d, d), 1e-6); t += w * ${f(s.z)}; ws += w;`);
  return `float groundAt(vec2 p) { vec2 d; float w; float t = 0.0; float ws = 0.0; ${terms.join(" ")} return t / ws; }`;
}

// A shader for one model, tinting what lies inside the lit marker's shapes. It works in eye coordinates, turned into
// local metres by a matrix set each frame: model.glb is quantised by gltfpack, so its own coordinates aren't metres.
// Unlit, it returns at once, and the model looks exactly as without it.
function markerShader(list) {
  if (list.length === 0) return null;
  const functions = [];
  const branches = list.map((m) => {
    const names = m.shapes.map((s, k) => {
      functions.push(shapeGLSL(s, `marker${m.index}_${k}`));
      return `marker${m.index}_${k}(p, n)`;
    });
    return `if (lit == ${m.index}) return ${names.join(" || ")};`;
  });
  // Only drapes need the normal, and the map's model may have none.
  const drapes = list.some((m) => m.shapes.some((s) => s.type === "drape"));
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const colour = `vec3(${[MARK_COLOUR.red, MARK_COLOUR.green, MARK_COLOUR.blue].map((c) => linear(c).toFixed(4)).join(", ")})`;
  return new Cesium.CustomShader({
    uniforms: {
      u_litMarker: { type: Cesium.UniformType.FLOAT, value: -1 },
      u_litGlow: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_eyeToLocal: { type: Cesium.UniformType.MAT4, value: new Cesium.Matrix4() },
    },
    fragmentShaderText: `
${drapes ? groundGLSL() : ""}
${functions.join("\n")}
bool inLitMarker(vec3 p, vec3 n, int lit) {
  ${branches.join("\n  ")}
  return false;
}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  if (u_litMarker < 0.0) return;
  vec3 p = (u_eyeToLocal * vec4(fsInput.attributes.positionEC, 1.0)).xyz;
  vec3 n = ${drapes ? "normalize((u_eyeToLocal * vec4(fsInput.attributes.normalEC, 0.0)).xyz)" : "vec3(0.0, 0.0, 1.0)"};
  if (!inLitMarker(p, n, int(u_litMarker + 0.5))) return;
  // Lighter and a little warmer, not recoloured: mixing in yellow turned the trees' dark green olive.
  material.diffuse *= vec3(1.5, 1.45, 1.0);
  // More for thin, dark things, the lamps' poles, on which lightening hardly shows.
  material.emissive += ${colour} * (0.03 + u_litGlow);
  // The translucent driveway barely changes otherwise, as the map shows through it.
  material.alpha = mix(material.alpha, 1.0, 0.4);
}`,
  });
}
const STRONG_GLOW = 0.5; // for `highlight: strong` in the spec, added to the yellow's emission
const modelShader = markerShader(markers.filter((m) => !m.map));
const mapShader = useGoogle ? null : markerShader(markers.filter((m) => m.map));
const markerShaders = [modelShader, mapShader].filter(Boolean);
let litIndex = -1; // the marker whose object is lit, if any

// Only while something is lit: the shaders need the camera, in local metres.
const eyeToLocal = new Cesium.Matrix4();
const localFromWorld = new Cesium.Matrix4();
scene.preRender.addEventListener(() => {
  if (litIndex < 0) return;
  Cesium.Matrix4.inverseTransformation(modelMatrix, localFromWorld);
  Cesium.Matrix4.multiply(localFromWorld, camera.inverseViewMatrix, eyeToLocal);
  for (const shader of markerShaders) shader.setUniform("u_eyeToLocal", eyeToLocal);
});

// On the Google map, the map's objects are photogrammetry, so a volume tints whatever of the map lies inside it. Placed
// with the starting height, a few centimetres from the measured one.
function markerClassification(marker) {
  const color = Cesium.ColorGeometryInstanceAttribute.fromColor(MARK_COLOUR.withAlpha(0.22));
  const at = (x, y, z) => Cesium.Matrix4.multiplyByTranslation(modelMatrix, new Cesium.Cartesian3(x, y, z), new Cesium.Matrix4());
  const vertexFormat = Cesium.VertexFormat.POSITION_ONLY;
  const instance = (s) => {
    if (s.type === "ellipsoid") {
      return new Cesium.GeometryInstance({ geometry: new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(...s.radii), vertexFormat }), modelMatrix: at(...s.centre), attributes: { color } });
    }
    if (s.type === "cylinder") {
      const geometry = new Cesium.CylinderGeometry({ length: s.z[1] - s.z[0], topRadius: s.radius, bottomRadius: s.radius, vertexFormat });
      return new Cesium.GeometryInstance({ geometry, modelMatrix: at(s.xy[0], s.xy[1], (s.z[0] + s.z[1]) / 2), attributes: { color } });
    }
    const outline = new Cesium.PolygonHierarchy(s.polygon.map(([x, y]) => localToWorld(modelMatrix, x, y, 0)));
    const geometry = new Cesium.PolygonGeometry({ polygonHierarchy: outline, height: originHeight + s.z[0], extrudedHeight: originHeight + s.z[1], vertexFormat });
    return new Cesium.GeometryInstance({ geometry, attributes: { color } });
  };
  const primitive = new Cesium.ClassificationPrimitive({
    geometryInstances: marker.shapes.map(instance),
    classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
    allowPicking: false,
    asynchronous: false,
  });
  primitive.show = false;
  return scene.primitives.add(primitive);
}
const classifications = new Map(useGoogle ? markers.filter((m) => m.map).map((m) => [m.index, markerClassification(m)]) : []);

// The Geoportal map's buildings and trees: GUGiK's, already cut to the map limit and clear of the model, standing on the
// same surveyed ground (scripts/gugik_surroundings.py). One small file, in the model's frame.
async function loadSurroundings() {
  const surroundings = await Cesium.Model.fromGltfAsync({
    url: "./surroundings.glb",
    modelMatrix,
    upAxis: Cesium.Axis.Y,
    forwardAxis: Cesium.Axis.X,
    // Their shadows fall on the ground and the model, which is what the sun study needs. Receiving them too speckled
    // the long flat walls lit at a low angle, and walls facing away from the sun are already darker by their shading.
    shadows: Cesium.ShadowMode.CAST_ONLY,
    credit: GUGIK_CREDIT,
    customShader: mapShader ?? undefined,
  });
  // Lit like the model, so shaded walls don't go black against the unlit photo.
  surroundings.environmentMapManager.brightness = config.modelAmbientBrightness;
  surroundings.environmentMapManager.saturation = 0.4;
  scene.primitives.add(surroundings);
  performance.mark("map opened");
  return surroundings;
}

// --- the model ----------------------------------------------------------------------------
async function loadModel() {
  const model = await Cesium.Model.fromGltfAsync({
    url: "./model.glb",
    modelMatrix,
    // The model is authored in east-north-up. Cesium's default glTF forward axis (+Z) would turn it 90 degrees.
    upAxis: Cesium.Axis.Y,
    forwardAxis: Cesium.Axis.X,
    shadows: Cesium.ShadowMode.ENABLED,
    customShader: modelShader ?? undefined,
  });
  // The map's photos are unlit. Without extra ambient light the dark facades go black in the shade.
  model.environmentMapManager.brightness = config.modelAmbientBrightness;
  // Less of the default ground and sky tint, so graphite stays neutral rather than turning green.
  model.environmentMapManager.saturation = 0.4;
  scene.primitives.add(model);
  performance.mark("model file read");
  return model;
}

// The model first. It's a small file, but it would otherwise wait behind hundreds of map tiles: about 10 s on 4G. The
// Google tileset is opened alongside, which is two small requests, and only added once the model is read, so its tiles
// still come after. The Geoportal map's buildings and trees are a single small file, so they can come alongside.
const [model, surroundings, tileset] = await Promise.all([
  loadModel(),
  useGoogle ? null : loadSurroundings(),
  useGoogle ? openGoogleTiles() : null,
]);
if (tileset) {
  reportRefusedTiles(tileset);
  scene.primitives.add(tileset);
  performance.mark("map opened");
}
const whenReady = (m) => new Promise((resolve) => (m.ready ? resolve() : m.readyEvent.addEventListener(() => resolve())));
const surroundingsReady = useGoogle ? Promise.resolve() : whenReady(surroundings);

// Tiles refused after the map opened, say once a quota runs out: Cesium only logs them, so the page would just stay
// empty. A refusal turns away nearly every tile, while a patchy connection loses a few among many, so it takes 3 failures
// and more failures than loaded tiles.
function reportRefusedTiles(tileset) {
  let loadedTiles = 0;
  let failedTiles = 0;
  tileset.tileLoad.addEventListener(() => loadedTiles++);
  tileset.tileFailed.addEventListener(({ message }) => {
    failedTiles++;
    if (mapFailed || failedTiles < 3 || failedTiles <= loadedTiles) return;
    mapFailed = true;
    // Cesium's message can end "Status Code: 429", but for tiles it's usually just "Request has failed."
    const code = String(message).match(/Status Code: (\d+)/)?.[1];
    setStatus(`Nie udało się wczytać mapy Google: serwer mapy ${code ? `odpowiedział kodem ${code}` : "odrzuca zapytania"}.`);
    offerGeoportal();
  });
}

// --- before and after ------------------------------------------------------------------------
const projectBox = document.getElementById("project");
// What "Pokaż projekt" hides: the model's groups from blender/build.py, whose names scripts/check_model.py checks. Not
// "Existing", the tężnia and its paving, which are already there, nor "Backing", which belongs to the Google map.
const PROJECT_NODES = ["Building", "Site", "Furniture", "Trees"];

function showProject(show) {
  if (model.ready) for (const name of PROJECT_NODES) model.getNode(name).show = show;
  const cuts = tileset?.clippingPolygons;
  if (cuts) {
    for (const cut of projectCuts) {
      if (show && !cuts.contains(cut)) cuts.add(cut);
      if (!show && cuts.contains(cut)) cuts.remove(cut);
    }
  }
  // On the Geoportal map, GUGiK's trees where the project paves or builds come back, as the Google map's own trees do
  // when its cut is lifted.
  if (surroundings?.ready) {
    for (const part of ["crowns", "trunks"]) {
      const node = surroundings.getNode(`Project-site tree ${part}`);
      if (node) node.show = !show;
    }
  }
}
// Nodes can only be reached once each model is ready, and the switch may have asked for the project hidden before that.
whenReady(model).then(() => showProject(projectBox.checked));
surroundingsReady.then(() => showProject(projectBox.checked));
projectBox.addEventListener("change", (event) => showProject(event.target.checked));
if (switchState?.project === false) {
  projectBox.checked = false;
  projectBox.dispatchEvent(new Event("change"));
}

// --- marked places: pins, hover and popups ---------------------------------------------------------------------------
const info = document.getElementById("info");
let hoveredPin = null; // marker indexes
let hoveredObject = null;
let openMarker = null;

// A pin goes with its object when the project is hidden, unless that's already there. On the Google map the map's
// objects on the project's paving go with the cut under it, so there they light up only with the project hidden.
const pinShown = (m) => !m.project || projectBox.checked;
const objectShown = (m) => pinShown(m) && !(m.map && useGoogle && projectBox.checked);

// What a pin's head shows, and the popup's label with it: the plan's number or "?", an icon, or for a surface a swatch
// like the plan's legend. The icons are drawn in the heads' text colour.
const PIN_ICONS = {
  lamp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5a6.5 6.5 0 0 0-3.9 11.7c.6.5.9 1.2.9 1.9v1.4h6v-1.4c0-.7.3-1.4.9-1.9A6.5 6.5 0 0 0 12 2.5zM10 20.5h4"/></svg>',
  bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="15.5" r="3.5"/><circle cx="18.5" cy="15.5" r="3.5"/><path d="M5.5 15.5 9 8.5l3 7H5.5M9 8.5h6.5L12 15.5M15.5 8.5l3 7M7.5 6.5h3M15.5 8.5 15 6h2"/></svg>',
  tree: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.5 14.5A3.5 3.5 0 0 1 6.2 8.2 4.5 4.5 0 0 1 12 3.5a4.5 4.5 0 0 1 5.8 4.7 3.5 3.5 0 0 1-1.3 6.3z"/><path d="M12 14.5V21"/></svg>',
  // The legend's swatches, in a yellow head like the rest, so that grey still means hidden.
  deck: '<span class="swatch swatch-deck"></span>',
  paving: '<span class="swatch swatch-paving"></span>',
};
function showLabel(element, m) {
  element.classList.toggle("icon", Boolean(PIN_ICONS[m.icon]));
  if (PIN_ICONS[m.icon]) element.innerHTML = PIN_ICONS[m.icon];
  else element.textContent = m.label;
}

// The pin under the pointer, else the object, else the open popup's. One at a time.
function updateHighlight() {
  const lit = [hoveredPin, hoveredObject, openMarker].find((i) => i !== null) ?? null;
  litIndex = lit !== null && objectShown(markers[lit]) ? lit : -1;
  for (const shader of markerShaders) {
    shader.setUniform("u_litMarker", litIndex);
    shader.setUniform("u_litGlow", litIndex >= 0 && markers[litIndex].strong ? STRONG_GLOW : 0);
  }
  for (const [index, primitive] of classifications) primitive.show = index === litIndex;
  for (const m of markers) m.head.classList.toggle("lit", m.index === lit);
}

function openPopup(index) {
  openMarker = index;
  info.hidden = index === null;
  if (index !== null) {
    const m = markers[index];
    showLabel(document.getElementById("info-label"), m);
    document.getElementById("info-title").textContent = m.title;
    const lines = m.lines.filter((line) => !line.map || line.map === contextName);
    document.getElementById("info-lines").replaceChildren(...lines.map((line) => Object.assign(document.createElement("li"), { textContent: line.text })));
    const note = document.getElementById("info-note");
    note.textContent = m.note ?? "";
    note.hidden = !m.note;
  }
  updateHighlight();
}
document.getElementById("info-close").addEventListener("click", () => openPopup(null));
projectBox.addEventListener("change", () => {
  if (openMarker !== null && !pinShown(markers[openMarker])) openPopup(null);
  updateHighlight();
});

// The object under a position on the canvas: the point of the map or model there, inside one of the shapes. Whatever
// stands in front, a building or another tree, is what's found instead, so objects count only where they can be seen.
// The point comes from the depth buffer, about 3 cm out from 100 m away, and the deck's shape reaches only 3 cm over it.
const PICK_SLACK_M = 0.1;
const toLocalScratch = new Cesium.Matrix4();
function markerAt(position) {
  if (!scene.pickPositionSupported) return null;
  const world = scene.pickPosition(position);
  if (!world) return null;
  const p = Cesium.Matrix4.multiplyByPoint(Cesium.Matrix4.inverseTransformation(modelMatrix, toLocalScratch), world, world);
  return byPriority.find((m) => objectShown(m) && m.shapes.some((s) => inShape(s, p, PICK_SLACK_M)))?.index ?? null;
}

// Each pin: a numbered head over the object, and a line from it down to just above the ground. The heads are page
// elements, always in front, so they can be found and clicked. The lines are in the scene, in local metres, so they go
// into the object they stand on, its roof say, and behind whatever stands in front. Their light halo is translucent,
// which puts them after the solid scene, so a pointer finds the object behind them, not the line.
const STEM_GAP_M = 0.3;
const pinsLayer = document.getElementById("pins");
const stems = scene.primitives.add(new Cesium.PolylineCollection({ modelMatrix: Cesium.Matrix4.clone(modelMatrix) }));
// The heads' dark grey, 2 pixels wide, with a light halo a pixel wide each side, and edges softened over a pixel of the
// screen: Cesium's own outlined line has hard edges, and its halo broke up into dashes.
const stemMaterial = new Cesium.Material({
  translucent: true,
  fabric: {
    uniforms: { color: Cesium.Color.fromCssColorString("#24313c"), halo: Cesium.Color.WHITE.withAlpha(0.55) },
    source: `
in float v_width;
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float d = abs(materialInput.st.t - 0.5) * v_width; // pixels from the middle of the line
  float soft = 0.5 / czm_pixelRatio;
  float line = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, d);
  vec4 c = mix(halo, color, line);
  c.a *= 1.0 - smoothstep(2.0 - soft, 2.0 + soft, d);
  c = czm_gammaCorrect(c);
  material.diffuse = c.rgb;
  material.alpha = c.a;
  return material;
}`,
  },
});
for (const m of markers) {
  m.foot = [m.pin[0], m.pin[1], m.lineEnd ?? groundAt(m.pin[0], m.pin[1]) + STEM_GAP_M]; // or on top of a lamp, say
  m.stem = stems.add({
    positions: [new Cesium.Cartesian3(...m.pin), new Cesium.Cartesian3(...m.foot)],
    width: 5, // pixels, with room for the soft edges
    material: stemMaterial,
    show: false,
  });
  m.head = Object.assign(document.createElement("button"), { className: "pin-head", title: m.title, hidden: true });
  showLabel(m.head, m);
  m.head.setAttribute("aria-label", m.label ? `${m.label}: ${m.title}` : m.title);
  const hover = (on) => () => {
    hoveredPin = on ? m.index : hoveredPin === m.index ? null : hoveredPin;
    updateHighlight();
  };
  m.head.addEventListener("pointerenter", hover(true));
  m.head.addEventListener("pointerleave", hover(false));
  m.head.addEventListener("focus", hover(true));
  m.head.addEventListener("blur", hover(false));
  m.head.addEventListener("click", () => openPopup(m.index));
  pinsLayer.append(m.head);
}

const mapEl = document.getElementById("map");
const toPoint = new Cesium.Cartesian3();
function onScreen(local) {
  const world = localToWorld(modelMatrix, ...local);
  const depth = Cesium.Cartesian3.dot(Cesium.Cartesian3.subtract(world, camera.positionWC, toPoint), camera.directionWC);
  if (depth <= 0) return undefined;
  const xy = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
  return xy && { x: xy.x, y: xy.y, depth, distance: Cesium.Cartesian3.magnitude(toPoint) };
}

// Heads too close on screen spread apart, and their lines lean out to them from the objects' feet, still in the scene,
// so objects still hide them. A head's spread is in screen pixels; its line's top moves by as much across the view, at
// the pin's own depth, which projects to just where the head is. Each frame starts from the last spread, drawn back a
// little, so crowded heads settle just clear of each other and follow the camera smoothly, and lone ones go back over
// their objects.
const HEAD_PX = isTouch ? 34 : 28; // as in style.css
const SPREAD_GAP_PX = 4;
const SPREAD_MAX_PX = 90;
const SPREAD_RETURN = 0.85; // of the last frame's spread
function spreadHeads(shown) {
  const reach = HEAD_PX + SPREAD_GAP_PX;
  for (const m of shown) {
    m.spread.x *= SPREAD_RETURN;
    m.spread.y *= SPREAD_RETURN;
  }
  for (let round = 0; round < 10; round++) {
    let moved = false;
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const [a, b] = [shown[i], shown[j]];
        let dx = b.anchor.x + b.spread.x - (a.anchor.x + a.spread.x);
        let dy = b.anchor.y + b.spread.y - (a.anchor.y + a.spread.y);
        let d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        if (d < 0.01) [dx, dy, d] = [Math.cos(a.index + b.index), Math.sin(a.index + b.index), 1]; // one over the other: any way
        const push = (reach - d) / 2 / d; // half each, along the line between them
        a.spread.x -= dx * push;
        a.spread.y -= dy * push;
        b.spread.x += dx * push;
        b.spread.y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const m of shown) {
    const length = Math.hypot(m.spread.x, m.spread.y);
    if (length > SPREAD_MAX_PX) [m.spread.x, m.spread.y] = [(m.spread.x * SPREAD_MAX_PX) / length, (m.spread.y * SPREAD_MAX_PX) / length];
  }
}

const pixelSize = new Cesium.Cartesian2();
const leanWorld = new Cesium.Cartesian3();
const leanUp = new Cesium.Cartesian3();
const leanLocal = new Cesium.Cartesian3();
const worldToLocal = new Cesium.Matrix4();
function leanStem(m) {
  if (Math.hypot(m.spread.x, m.spread.y) < 0.5) {
    if (m.leaning) m.stem.positions = [m.pinLocal, m.footLocal];
    m.leaning = false;
    return;
  }
  camera.frustum.getPixelDimensions(scene.drawingBufferWidth, scene.drawingBufferHeight, m.anchor.depth, scene.pixelRatio, pixelSize);
  Cesium.Cartesian3.multiplyByScalar(camera.rightWC, m.spread.x * pixelSize.x, leanWorld);
  Cesium.Cartesian3.add(leanWorld, Cesium.Cartesian3.multiplyByScalar(camera.upWC, -m.spread.y * pixelSize.y, leanUp), leanWorld);
  Cesium.Matrix4.multiplyByPointAsVector(worldToLocal, leanWorld, leanLocal);
  m.stem.positions = [Cesium.Cartesian3.add(m.pinLocal, leanLocal, new Cesium.Cartesian3()), m.footLocal];
  m.leaning = true;
}
for (const m of markers) {
  m.spread = { x: 0, y: 0 };
  m.pinLocal = new Cesium.Cartesian3(...m.pin);
  m.footLocal = new Cesium.Cartesian3(...m.foot);
}

// Before each frame is drawn, with the camera already moved for it, so the leaning lines and the heads agree.
scene.preRender.addEventListener(() => {
  const loading = mapEl.classList.contains("loading");
  const { clientWidth: w, clientHeight: h } = scene.canvas;
  // On the Google map the model is lifted once the ground's height is measured, and the lines with it.
  if (!Cesium.Matrix4.equals(stems.modelMatrix, modelMatrix)) Cesium.Matrix4.clone(modelMatrix, stems.modelMatrix);
  Cesium.Matrix4.inverseTransformation(modelMatrix, worldToLocal);
  const shown = [];
  for (const m of markers) {
    const anchor = !loading && pinShown(m) ? onScreen(m.pin) : undefined;
    const show = Boolean(anchor) && anchor.x >= 0 && anchor.y >= 0 && anchor.x <= w && anchor.y <= h;
    if (m.head.hidden === show) m.head.hidden = !show;
    m.stem.show = show; // a line only under a head
    if (!show) {
      m.spread.x = m.spread.y = 0;
      continue;
    }
    m.anchor = anchor;
    shown.push(m);
  }
  spreadHeads(shown);
  for (const m of shown) {
    m.top = { x: m.anchor.x + m.spread.x, y: m.anchor.y + m.spread.y, distance: m.anchor.distance };
    m.head.style.transform = `translate(${m.top.x.toFixed(1)}px, ${m.top.y.toFixed(1)}px) translate(-50%, -100%)`;
    leanStem(m);
  }
  // Nearer heads over farther ones.
  shown.sort((a, b) => b.top.distance - a.top.distance).forEach((m, rank) => (m.head.style.zIndex = String(rank + 1)));
});
scene.postRender.addEventListener(() => testBehind());

// A head that something stands in front of, a tree say, turns grey and faint, as the line under it is hidden: the
// nearest surface in the frame just drawn, at the head's middle, is nearer than the pin. A depth read stalls the GPU a
// little, so one head a frame, each again once the camera has moved, or else every second as tiles load in.
const BEHIND_MARGIN_M = 0.5;
const lastEye = new Cesium.Cartesian3();
const lastDirection = new Cesium.Cartesian3();
const headMiddle = new Cesium.Cartesian2();
const behindHit = new Cesium.Cartesian3();
let viewCount = 0;
let behindTurn = 0;
function testBehind() {
  if (!scene.pickPositionSupported) return;
  if (!Cesium.Cartesian3.equalsEpsilon(camera.positionWC, lastEye, 0, 0.01) || !Cesium.Cartesian3.equalsEpsilon(camera.directionWC, lastDirection, 1e-5)) {
    Cesium.Cartesian3.clone(camera.positionWC, lastEye);
    Cesium.Cartesian3.clone(camera.directionWC, lastDirection);
    viewCount++;
  }
  const now = performance.now();
  for (let k = 0; k < markers.length; k++) {
    const m = markers[(behindTurn + k) % markers.length];
    if (m.head.hidden || (m.testedView === viewCount && now - m.testedAt < 1000)) continue;
    behindTurn = m.index + 1;
    [m.testedView, m.testedAt] = [viewCount, now];
    headMiddle.x = m.top.x;
    headMiddle.y = m.top.y - m.head.offsetHeight / 2;
    const hit = headMiddle.y >= 0 ? scene.pickPosition(headMiddle, behindHit) : undefined;
    m.head.classList.toggle("behind", Boolean(hit) && Cesium.Cartesian3.distance(hit, camera.positionWC) < m.top.distance - BEHIND_MARGIN_M);
    return;
  }
}

// Objects under a mouse: tested at most once a frame, and not while a drag moves the camera. Touch has no hover: a tap
// opens the popup, and the object stays lit while it's open.
let hoverAt = null;
let dragging = false;
scene.canvas.addEventListener("pointerdown", () => (dragging = true));
addEventListener("pointerup", () => (dragging = false));
scene.canvas.addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse" && !dragging) hoverAt = new Cesium.Cartesian2(event.offsetX, event.offsetY);
});
scene.canvas.addEventListener("pointerleave", () => (hoverAt = new Cesium.Cartesian2(-1, -1)));
scene.postRender.addEventListener(() => {
  if (!hoverAt) return;
  const over = hoverAt.x >= 0 ? markerAt(hoverAt) : null;
  hoverAt = null;
  if (over === hoveredObject) return;
  hoveredObject = over;
  scene.canvas.style.cursor = over !== null ? "pointer" : "";
  updateHighlight();
});

// Cesium's own click actions select and track entities, which the page has none of. They render a picking pass first,
// which draws the pins' lines into the depth read here, so a click on an object behind a line found the line.
viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
new Cesium.ScreenSpaceEventHandler(viewer.canvas).setInputAction((click) => openPopup(markerAt(click.position)), Cesium.ScreenSpaceEventType.LEFT_CLICK);

if (!clippingSupported) {
  console.warn("Clipping polygons are not supported here: the old map mesh stays visible under the project.");
}

// --- show the map once there's something to see ---------------------------------------------
// Until then the canvas is hidden (the "loading" class in index.html), because all it can show is a black void.
const DETAILED_TILE_ERROR_M = 100; // on the Google map, a tile this fine means the ground is recognisable
const SHOW_ANYWAY_MS = 20000; // on a slow connection, a partly loaded map beats an empty page

const mapHasDetail = new Promise((resolve) => {
  // On the Geoportal map: the quick, coarse aerial photo is all there, and so are the buildings.
  if (!useGoogle) return Promise.all([coarsePhotoIdle, surroundingsReady]).then(resolve);
  const stop = tileset.tileVisible.addEventListener((tile) => {
    if (tile.geometricError <= DETAILED_TILE_ERROR_M) {
      stop();
      resolve();
    }
  });
});
const tilesSettled = useGoogle ? new Promise((resolve) => tileset.initialTilesLoaded.addEventListener(() => resolve())) : surroundingsReady;
// On the Geoportal map, also the sharp photo and the ground for this view.
// Checked every frame: the globe's progress event can report an empty queue a frame before tilesLoaded agrees, and then
// stays silent.
const globeSettled = new Promise((resolve) => {
  if (useGoogle) return resolve();
  const stop = scene.postRender.addEventListener(() => {
    if (scene.globe.tilesLoaded) {
      stop();
      resolve();
    }
  });
});
const mapSettled = Promise.all([tilesSettled, globeSettled]);
const modelReady = whenReady(model);
mapHasDetail.then(() => performance.mark("map has detail"));
modelReady.then(() => {
  performance.mark("model ready");
  // The sheet that fills the hollow Google trees where the map is cut. Nothing here needs it, and it would show.
  model.getNode("Backing").show = useGoogle;
});
const loaded = Promise.all([mapHasDetail, modelReady]);
mapSettled.then(() => performance.mark("map settled"));

const mapShown = Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, SHOW_ANYWAY_MS))]).then(() => {
  stopWatchingCamera();
  document.getElementById("map").classList.remove("loading");
  performance.mark("map shown");
});
// The blurred map still needs explaining until it's sharp. Not for ever, though: once in about six test runs the signal
// for "sharp" never came, and the message then sat over a working map.
const LOADING_MESSAGE_AT_MOST_MS = 30000;
Promise.race([mapSettled, mapShown.then(() => new Promise((resolve) => setTimeout(resolve, LOADING_MESSAGE_AT_MOST_MS)))]).then(() => {
  if (!mapFailed) setStatus("");
});

// --- measure the ground ------------------------------------------------------------------------
// Anchor the model's height on the map: take the median of (map height - expected local z) over
// points on open lawn. Never convert the drawings' levels by hand: the drawings and the map use
// different height systems.
async function sampleOriginHeight() {
  const positions = site.groundProbes.map((p) => {
    const world = localToWorld(enuMatrix(0), p.xy[0], p.xy[1], 0);
    return Cesium.Cartographic.fromCartesian(world);
  });
  const sampled = await scene.sampleHeightMostDetailed(positions, [model]); // the map's height, not the top of the model above it
  // Cesium can return a far-off height when nothing has loaded. Trust only what's plausible here.
  const heights = sampled
    .map((c, i) => (c && c.height !== undefined ? c.height - site.groundProbes[i].z : null))
    .filter((h) => h !== null && Math.abs(h - FALLBACK_HEIGHT) < PLAUSIBLE_RANGE)
    .sort((a, b) => a - b);
  if (heights.length === 0) throw new Error("No usable height samples");
  return { median: heights[Math.floor(heights.length / 2)], heights };
}

// Not until the map is showing: this fetches the most detailed tiles under each probe, which would compete with the
// tiles the camera is waiting for. An orbit in progress keeps its old centre, which is only centimetres off.
// The Geoportal map's ground is built from the same survey as the model, so there it fits by construction.
const heightSettled = mapShown.then(async () => {
  if (!useGoogle) return;
  try {
    const result = await sampleOriginHeight();
    originHeight = result.median;
    heightSamples = result.heights;
    modelMatrix = enuMatrix(originHeight);
    model.modelMatrix = modelMatrix;
    performance.mark("height measured");
  } catch (error) {
    console.warn("Height sampling failed, using the default", error);
  }
});

// Test hook, used by scripts/shots.mjs and scripts/test_page.mjs.
window.app = {
  viewer,
  tileset,
  surroundings,
  model,
  get modelMatrix() {
    return modelMatrix;
  },
  get originHeight() {
    return originHeight;
  },
  get heightSamples() {
    return heightSamples;
  },
  heightSettled,
  startup,
  groundAt,
  goTo,
  stopOrbit,
  localToWorld,
  cameraTarget,
  contextName,
  markers: {
    list: markers,
    stems,
    // The marker whose object is lit, and the one whose popup is open, by id.
    get lit() {
      return litIndex >= 0 ? markers[litIndex].id : null;
    },
    get open() {
      return openMarker === null ? null : markers[openMarker].id;
    },
    markerAt: (position) => markers[markerAt(position)]?.id ?? null,
  },
};
