// Public settings for the page. The ion token here is the restricted production token:
// it is visible to anyone and locked to this site's address, assets:read only.
// It stays empty in the working repo; scripts/deploy.sh fills it in the published copy.
export const config = {
  ionToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6InYxVEFsOHFUOEZnNEoyWnYiLCJqdGkiOiJkMmFmNTc1Yi1lZjhiLTRjMzMtYjhjMC03Y2RjZTAzZjI5MDYiLCJpZCI6NTQzMTI1LCJzdWIiOiIzLW4iLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoia29udGVuZXJ5LTNkLXByb2QiLCJpYXQiOjE3OTM4Nzc0MTF9.QEQ6jf_KGt2UwN0HuhNBajd2J64o9tJ66vZFk2Vut34",
  // "geoportal": GUGiK's aerial photo on the surveyed ground, with GUGiK's buildings and trees. Current, and needs no
  // Cesium ion. The default since 2026-11-06, Jarek's choice.
  // "google": Google Photorealistic 3D Tiles through Cesium ion (counts against the monthly quota). The page has a switch.
  context: "geoportal",
  localContext: "geoportal",
  // Manual adjustments if the map's data shifts: metres east, north, up.
  offset: { east: 0, north: 0, up: 0 },
  initialCamera: "overview",
  shadowDepthBias: 0.0003,
  modelAmbientBrightness: 2.0,
  // Google map detail on phones, in pixels of error allowed on screen (Cesium's maximumScreenSpaceError). Desktop uses
  // 16. Higher loads faster and less, and looks blurrier.
  phoneScreenSpaceError: 24,
};
