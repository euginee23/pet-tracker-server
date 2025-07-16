const turf = require("@turf/turf");

function isInsideGeofence(deviceLat, deviceLng, geofences) {
  const point = turf.point([deviceLng, deviceLat]);
  let isInsideAny = false;
  let minDistance = Infinity;

  for (const fence of geofences) {
    const type = fence.type?.toLowerCase();

    if (
      type === "circle" &&
      !isNaN(fence.center_lat) &&
      !isNaN(fence.center_lng) &&
      !isNaN(fence.radius)
    ) {
      const center = turf.point([
        Number(fence.center_lng),
        Number(fence.center_lat),
      ]);
      const radius = Number(fence.radius);
      const distanceToCenter = turf.distance(center, point, {
        units: "meters",
      });

      console.log(
        `📏 Circle check for ${
          fence.device_id
        }: dist=${distanceToCenter.toFixed(2)}m, radius=${radius}`
      );

      if (distanceToCenter <= radius) {
        isInsideAny = true;
        break;
      } else {
        const diff = distanceToCenter - radius;
        if (diff < minDistance) minDistance = diff;
      }
    }

    if ((type === "polygon" || type === "rectangle") && fence.poly_rect) {
      try {
        const coords = JSON.parse(fence.poly_rect);
        if (!Array.isArray(coords) || coords.length < 3) continue;

        const geoJsonCoords = coords.map(([lat, lng]) => [lng, lat]);
        geoJsonCoords.push(geoJsonCoords[0]);

        const polygon = turf.polygon([geoJsonCoords]);

        if (turf.booleanPointInPolygon(point, polygon)) {
          isInsideAny = true;
          break;
        }

        const line = turf.lineString(geoJsonCoords);
        const distance = turf.pointToLineDistance(point, line, {
          units: "meters",
        });

        if (distance < minDistance) minDistance = distance;
      } catch (err) {
        console.warn("⚠️ Invalid polygon for geofence:", err.message);
      }
    }
  }

  return {
    isInside: isInsideAny,
    distance: isInsideAny ? 0 : Number(minDistance.toFixed(2)),
  };
}

module.exports = isInsideGeofence;
