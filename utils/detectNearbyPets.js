const turf = require("@turf/turf");

/**
 * DETECT NEARBY PETS
 *
 * @param {Object} currentPet - The current pet's data.
 * @param {number} currentPet.lat - Latitude of the current pet.
 * @param {number} currentPet.lng - Longitude of the current pet.
 * @param {Array} otherPets - List of other pets' data.
 * @param {number} otherPets[].lat - Latitude of another pet.
 * @param {number} otherPets[].lng - Longitude of another pet.
 * @param {number} [radius=10] - Detection radius in meters.
 * @returns {Array} - List of nearby pets within the specified radius.
 */
function detectNearbyPets(currentPet, otherPets, radius = 10) {
  const currentPoint = turf.point([currentPet.lng, currentPet.lat]);

  const nearbyPets = otherPets.filter((pet) => {
    const otherPoint = turf.point([pet.lng, pet.lat]);
    const distance = turf.distance(currentPoint, otherPoint, { units: "meters" });

    return distance <= radius;
  });

  return nearbyPets;
}

module.exports = detectNearbyPets;
