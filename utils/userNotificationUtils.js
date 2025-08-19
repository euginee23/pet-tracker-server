/**
 * Utility functions for user notifications and contact information
 */

/**
 * Gets a user's phone number by their ID
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {Number} userId - User ID to lookup
 * @returns {Promise<String|null>} - Phone number or null if not found
 */
async function getUserPhoneNumber(pool, userId) {
  let connection;
  try {
    if (!userId) {
      console.error("❌ getUserPhoneNumber: No userId provided");
      return null;
    }
    
    connection = await pool.getConnection();
    
    const [rows] = await connection.query(
      "SELECT phone FROM users WHERE user_id = ?",
      [userId]
    );
    
    if (rows.length === 0) {
      console.warn(`⚠️ No user found with ID ${userId}`);
      return null;
    }
    
    const phoneNumber = rows[0].phone;
    
    // Check if the phone number is valid
    if (!phoneNumber || phoneNumber === "0" || phoneNumber.trim() === "") {
      console.warn(`⚠️ User ${userId} has no valid phone number`);
      return null;
    }
    
    // Format the phone number for SMS
    let formattedPhone = phoneNumber;
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '63' + formattedPhone.substring(1);
    }
    
    return formattedPhone;
  } catch (err) {
    console.error(`❌ Error getting phone number for user ${userId}:`, err.message);
    return null;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Gets phone number for the owner of a specific tracker device
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {String} deviceId - Device ID to lookup
 * @returns {Promise<{userId: Number, phoneNumber: String}|null>} - User ID and phone number or null
 */
async function getTrackerOwnerPhone(pool, deviceId) {
  let connection;
  try {
    if (!deviceId) {
      console.error("❌ getTrackerOwnerPhone: No deviceId provided");
      return null;
    }
    
    connection = await pool.getConnection();
    
    const [rows] = await connection.query(
      `SELECT t.user_id, u.phone
       FROM trackers t
       JOIN users u ON t.user_id = u.user_id
       WHERE t.device_id = ?`,
      [deviceId]
    );
    
    if (rows.length === 0) {
      console.warn(`⚠️ No tracker found with device ID ${deviceId}`);
      return null;
    }
    
    const userId = rows[0].user_id;
    const phoneNumber = rows[0].phone;
    
    // Check if the phone number is valid
    if (!phoneNumber || phoneNumber === "0" || phoneNumber.trim() === "") {
      console.warn(`⚠️ User ${userId} (owner of ${deviceId}) has no valid phone number`);
      return { userId, phoneNumber: null };
    }
    
    // Format the phone number for SMS
    let formattedPhone = phoneNumber;
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '63' + formattedPhone.substring(1);
    }
    
    return { userId, phoneNumber: formattedPhone };
  } catch (err) {
    console.error(`❌ Error getting owner phone for device ${deviceId}:`, err.message);
    return null;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Checks if a user has SMS notifications enabled for a specific event type
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {Number} userId - User ID to check settings for
 * @param {String} eventType - Event type (online, offline, out_geofence, in_geofence, low_battery)
 * @returns {Promise<Boolean>} - Whether notifications are enabled
 */
async function isNotificationEnabled(pool, userId, eventType) {
  let connection;
  try {
    if (!userId || !eventType) {
      console.error("❌ isNotificationEnabled: Missing required parameters");
      return false;
    }
    
    connection = await pool.getConnection();
    
    const [rows] = await connection.query(
      `SELECT enable_sms_notification, ${eventType}
       FROM sms_notification_settings
       WHERE user_id = ?`,
      [userId]
    );
    
    if (rows.length === 0) {
      console.log(`❌ No notification settings found for user ${userId}`);
      return false;
    }
    
    console.log(`🔍 User ${userId} RAW notification settings:`, {
      enable_sms_notification: rows[0].enable_sms_notification,
      eventType: rows[0][eventType],
      eventTypeName: eventType
    });
    
    // Get raw values first (might be 0, 1, true, false, or other values)
    const rawGlobalEnabled = rows[0].enable_sms_notification;
    const rawEventEnabled = rows[0][eventType];
    
    // Improved conversion - handle numbers, strings, and boolean values
    const globalEnabled = rawGlobalEnabled === 1 || rawGlobalEnabled === '1' || rawGlobalEnabled === true;
    const eventEnabled = rawEventEnabled === 1 || rawEventEnabled === '1' || rawEventEnabled === true;
    
    console.log(`✅ User ${userId} notification settings (after conversion) - global: ${globalEnabled}, ${eventType}: ${eventEnabled}`);
    
    // Return true only if both global SMS and the specific event are enabled
    return globalEnabled && eventEnabled;
  } catch (err) {
    console.error(`❌ Error checking notification settings for user ${userId}:`, err.message);
    return false;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  getUserPhoneNumber,
  getTrackerOwnerPhone,
  isNotificationEnabled
};
