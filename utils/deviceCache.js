/**
 * Simple cache to store device-to-userId mappings
 * This reduces database queries for device ownership lookups
 */

// Cache object to store device-to-userId mappings
const deviceUserCache = new Map();

/**
 * Get the user ID for a device from the cache
 * @param {string} deviceId - The device ID to lookup
 * @returns {string|null} The user ID or null if not in cache
 */
function getCachedUserId(deviceId) {
  return deviceUserCache.get(deviceId) || null;
}

/**
 * Store a device-to-user mapping in the cache
 * @param {string} deviceId - The device ID
 * @param {string} userId - The user ID that owns this device
 */
function cacheDeviceUser(deviceId, userId) {
  deviceUserCache.set(deviceId, userId);
}

/**
 * Clear a device from the cache (useful when ownership changes)
 * @param {string} deviceId - The device ID to remove
 */
function clearCachedDevice(deviceId) {
  deviceUserCache.delete(deviceId);
}

/**
 * Clear the entire cache
 */
function clearCache() {
  deviceUserCache.clear();
}

module.exports = {
  getCachedUserId,
  cacheDeviceUser,
  clearCachedDevice,
  clearCache
};
