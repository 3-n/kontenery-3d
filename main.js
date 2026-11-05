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

const site = await (await fetch("./site.json")).json();
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
const ORTHOPHOTO_CREDIT = new Cesium.Credit("Ortofotomapa: GUGiK, geoportal.gov.pl", true); // Geoportal's terms: state the source
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
    credit: ORTHOPHOTO_CREDIT,
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
    credit: ORTHOPHOTO_CREDIT,
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
let activeView = config.initialCamera;
function goTo(id, duration = 1.6) {
  const view = site.cameras.find((c) => c.id === id);
  activeView = id;
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
    activeView = view.id;
    for (const b of cameraButtons.children) b.classList.toggle("active", b.dataset.id === view.id);
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
dateInput.value = `${year}-${/^\d\d-\d\d$/.test(switchState?.date) ? switchState.date : "03-20"}`;
timeInput.value = Number.isFinite(switchState?.time) ? switchState.time : 12 * 60;
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

async function loadMap() {
  const tileset = useGoogle
    ? await Cesium.createGooglePhotorealistic3DTileset(
        { onlyUsingWithGoogleGeocoder: true },
        {
          maximumScreenSpaceError: isSmallScreen ? 24 : 16,
          // On by default for these tiles. Before detail loads it reads heights off the coarse mesh and lifts a
          // street-level camera to about 20 m, for good. Without it you can zoom through the ground, but the view
          // buttons bring you back.
          enableCollision: false,
          // Go straight to the tiles this view needs, without every coarser level on the way down. On a phone on 4G
          // this halves the download and the time until the map is sharp, and the final picture is the same.
          skipLevelOfDetail: true,
        },
      )
    : await Cesium.createOsmBuildingsAsync();
  // Photogrammetry trees are hollow shells with no ground inside. Where the clipping below cuts one open,
  // culled back faces would show a black void; drawing them shows the inside of the crown instead.
  tileset.backFaceCulling = false;

  // Cut the old mesh where the project stands. The polygons lie on the ellipsoid, so the height doesn't affect them.
  if (clippingSupported && site.clipPolygons.length > 0) {
    tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
      polygons: site.clipPolygons.map(
        (c) => new Cesium.ClippingPolygon({ positions: c.polygon.map(([x, y]) => localToWorld(modelMatrix, x, y, 0)) }),
      ),
    });
  }
  tileset.clippingPlanes = mapLimitPlanes(tileset);
  if (!useGoogle && site.hiddenOsmBuildings.length > 0) {
    // Buildings OSM has where the model stands.
    tileset.style = new Cesium.Cesium3DTileStyle({ show: site.hiddenOsmBuildings.map((id) => `\${elementId} !== ${id}`).join(" && ") });
  }
  scene.primitives.add(tileset);
  performance.mark("map opened");
  return tileset;
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
  });
  // The map's photos are unlit. Without extra ambient light the dark facades go black in the shade.
  model.environmentMapManager.brightness = config.modelAmbientBrightness;
  // Less of the default ground and sky tint, so graphite stays neutral rather than turning green.
  model.environmentMapManager.saturation = 0.4;
  scene.primitives.add(model);
  performance.mark("model file read");
  return model;
}

// The model first. It's a small file, but it would otherwise wait behind hundreds of map tiles: about 10 s on 4G.
const model = await loadModel();
const tileset = await loadMap();

// --- before and after ------------------------------------------------------------------------
const projectBox = document.getElementById("project");
projectBox.addEventListener("change", (event) => {
  model.show = event.target.checked;
  if (tileset.clippingPolygons) tileset.clippingPolygons.enabled = event.target.checked;
});
if (switchState?.project === false) {
  projectBox.checked = false;
  projectBox.dispatchEvent(new Event("change"));
}

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

// --- show the map once there's something to see ---------------------------------------------
// Until then the canvas is hidden (the "loading" class in index.html), because all it can show is a black void.
const DETAILED_TILE_ERROR_M = 100; // on the Google map, a tile this fine means the ground is recognisable
const SHOW_ANYWAY_MS = 20000; // on a slow connection, a partly loaded map beats an empty page

const mapHasDetail = new Promise((resolve) => {
  if (!useGoogle) return coarsePhotoIdle.then(resolve); // the quick, coarse aerial photo is all there
  const stop = tileset.tileVisible.addEventListener((tile) => {
    if (tile.geometricError <= DETAILED_TILE_ERROR_M) {
      stop();
      resolve();
    }
  });
});
const tilesSettled = new Promise((resolve) => tileset.initialTilesLoaded.addEventListener(() => resolve()));
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
const modelReady = new Promise((resolve) => (model.ready ? resolve() : model.readyEvent.addEventListener(() => resolve())));
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
Promise.race([mapSettled, mapShown.then(() => new Promise((resolve) => setTimeout(resolve, LOADING_MESSAGE_AT_MOST_MS)))]).then(() => setStatus(""));

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
};
