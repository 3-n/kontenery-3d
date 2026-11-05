// Viewer for the project: places model.glb on a 3D map of its surroundings.
import { config } from "./config.js";

const params = new URLSearchParams(location.search);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

if (isLocal && !config.ionToken) {
  // Served by scripts/dev_server.py from .env; this file doesn't exist on the published site.
  config.ionToken = (await import("./config.local.js")).ionToken;
}
const contextName = (isLocal && params.get("context")) || (isLocal ? config.localContext : config.context);
const useGoogle = contextName === "google";
const isSmallScreen = matchMedia("(max-width: 640px)").matches;
if (isSmallScreen) document.getElementById("panel").open = false;

const site = await (await fetch("./site.json")).json();
const statusEl = document.getElementById("status");
const setStatus = (text) => {
  statusEl.textContent = text || "";
  statusEl.hidden = !text;
};

Cesium.Ion.defaultAccessToken = config.ionToken;

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
  // The Google tiles replace the globe entirely; the OSM context needs terrain and imagery.
  globe: useGoogle ? false : undefined,
  baseLayer: useGoogle
    ? false
    : new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/", maximumLevel: 19 })),
  terrainProvider: useGoogle ? undefined : await Cesium.createWorldTerrainAsync(),
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

// --- map context ----------------------------------------------------------------------
let tileset;
if (useGoogle) {
  tileset = await Cesium.createGooglePhotorealistic3DTileset(
    { onlyUsingWithGoogleGeocoder: true },
    {
      maximumScreenSpaceError: isSmallScreen ? 24 : 16,
      // On by default for these tiles. Before detail loads it reads heights off the coarse mesh and lifts a
      // street-level camera to about 20 m, for good. Without it you can zoom through the ground, but the view
      // buttons bring you back.
      enableCollision: false,
    },
  );
} else {
  tileset = await Cesium.createOsmBuildingsAsync();
}
// Photogrammetry trees are hollow shells with no ground inside. Where the clipping below cuts one open,
// culled back faces would show a black void; drawing them shows the inside of the crown instead.
tileset.backFaceCulling = false;
scene.primitives.add(tileset);

// Ellipsoid height of the ground here, in metres. Used only if sampling fails.
const FALLBACK_HEIGHT = 114.5;
const PLAUSIBLE_RANGE = 30;

// Anchor the model's height on the map: take the median of (map height - expected local z) over
// points on open lawn. Never convert the drawings' levels by hand: the drawings and the map use
// different height systems.
async function sampleOriginHeight() {
  const positions = site.groundProbes.map((p) => {
    const world = localToWorld(enuMatrix(0), p.xy[0], p.xy[1], 0);
    return Cesium.Cartographic.fromCartesian(world);
  });
  const sampled = useGoogle
    ? await scene.sampleHeightMostDetailed(positions)
    : await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions);
  // Cesium can return a far-off height when nothing has loaded. Trust only what's plausible here.
  const heights = sampled
    .map((c, i) => (c && c.height !== undefined ? c.height - site.groundProbes[i].z : null))
    .filter((h) => h !== null && Math.abs(h - FALLBACK_HEIGHT) < PLAUSIBLE_RANGE)
    .sort((a, b) => a - b);
  if (heights.length === 0) throw new Error("No usable height samples");
  return { median: heights[Math.floor(heights.length / 2)], heights };
}

setStatus("Ustalanie wysokości terenu…");
let originHeight = FALLBACK_HEIGHT;
let heightSamples = [];
try {
  const result = await sampleOriginHeight();
  originHeight = result.median;
  heightSamples = result.heights;
} catch (error) {
  console.warn("Height sampling failed, using the default", error);
}

const modelMatrix = enuMatrix(originHeight);

// --- clipping: cut the old mesh where the project stands ----------------------------------
const clippingSupported = Cesium.ClippingPolygonCollection.isSupported(scene);
if (clippingSupported && site.clipPolygons.length > 0) {
  tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
    polygons: site.clipPolygons.map(
      (c) => new Cesium.ClippingPolygon({ positions: c.polygon.map(([x, y]) => localToWorld(modelMatrix, x, y, 0)) }),
    ),
  });
}

// --- the model ----------------------------------------------------------------------------
setStatus("Wczytywanie modelu…");
const model = await Cesium.Model.fromGltfAsync({
  url: "./model.glb",
  modelMatrix,
  // The model is authored in east-north-up. Cesium's default glTF forward axis (+Z) would turn it 90 degrees.
  upAxis: Cesium.Axis.Y,
  forwardAxis: Cesium.Axis.X,
  shadows: Cesium.ShadowMode.ENABLED,
});
// The map's photos are unlit. Without extra ambient light the dark facades go black in the shade.
model.environmentMapManager.brightness = config.modelAmbientBrightness;
// Less of the default ground and sky tint, so graphite stays neutral rather than turning green.
model.environmentMapManager.saturation = 0.4;
scene.primitives.add(model);

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
}

function stopOrbit() {
  if (!orbiting) return;
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  camera.constrainedAxis = undefined;
  orbiting = false;
}

// Collision is off, so nothing else stops the camera going down through the ground.
scene.preRender.addEventListener(() => {
  if (!orbiting) return;
  const elevation = Math.asin(camera.position.z / Cesium.Cartesian3.magnitude(camera.position));
  // rotateDown raises the eye: Cesium names these after the way the view turns, not the way the eye moves.
  if (elevation < MIN_ORBIT_ELEVATION) camera.rotateDown(MIN_ORBIT_ELEVATION - elevation);
});

const cameraButtons = document.getElementById("cameras");
function goTo(id, duration = 1.6) {
  const view = site.cameras.find((c) => c.id === id);
  stopOrbit();
  camera.flyTo({ ...cameraTarget(view), duration, complete: view.orbit ? () => startOrbit(view) : undefined });
  for (const b of cameraButtons.children) b.classList.toggle("active", b.dataset.id === id);
}
for (const view of site.cameras) {
  const button = document.createElement("button");
  button.textContent = view.label;
  button.dataset.id = view.id;
  button.addEventListener("click", () => goTo(view.id));
  cameraButtons.append(button);
}
goTo(config.initialCamera, 0);

// --- date and time ------------------------------------------------------------------------
const dateInput = document.getElementById("date");
const timeInput = document.getElementById("time");
const timeLabel = document.getElementById("time-label");
const sunNote = document.getElementById("sun-note");
const dateButtons = document.querySelectorAll("#dates button");

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
  for (const b of dateButtons) b.classList.toggle("active", dateInput.value.endsWith(b.dataset.date));
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
dateInput.value = `${year}-03-20`;
timeInput.value = 12 * 60;
for (const b of dateButtons) {
  b.addEventListener("click", () => {
    dateInput.value = `${year}-${b.dataset.date}`;
    applyTime();
  });
}
dateInput.addEventListener("input", applyTime);
timeInput.addEventListener("input", applyTime);
applyTime();

// --- before and after ------------------------------------------------------------------------
document.getElementById("project").addEventListener("change", (event) => {
  model.show = event.target.checked;
  if (tileset.clippingPolygons) tileset.clippingPolygons.enabled = event.target.checked;
});

// --- click the building for its basic facts ----------------------------------------------------
const info = document.getElementById("info");
document.getElementById("info-close").addEventListener("click", () => (info.hidden = true));
const frame = site.buildingFrame;
const azimuth = Cesium.Math.toRadians(frame.azimuth_true_deg);

function onBuilding(world) {
  const inverse = Cesium.Matrix4.inverse(modelMatrix, new Cesium.Matrix4());
  const local = Cesium.Matrix4.multiplyByPoint(inverse, world, new Cesium.Cartesian3());
  const dx = local.x - frame.origin_local[0];
  const dy = local.y - frame.origin_local[1];
  const u = dx * Math.sin(azimuth) + dy * Math.cos(azimuth);
  const v = dx * Math.cos(azimuth) - dy * Math.sin(azimuth);
  return u >= site.footprint.u[0] && u <= site.footprint.u[1] && v >= site.footprint.v[0] && v <= site.footprint.v[1];
}

new Cesium.ScreenSpaceEventHandler(viewer.canvas).setInputAction((click) => {
  const picked = scene.pick(click.position);
  if (picked && picked.primitive === model) {
    const world = scene.pickPosition(click.position);
    if (world && onBuilding(world)) {
      info.hidden = false;
      return;
    }
  }
  info.hidden = true;
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

if (!clippingSupported) {
  console.warn("Clipping polygons are not supported here: the old map mesh stays visible under the project.");
}
setStatus("");

// Test hook, used by scripts/shots.mjs.
window.app = { viewer, tileset, model, modelMatrix, originHeight, heightSamples, goTo, stopOrbit, localToWorld, cameraTarget, contextName };
