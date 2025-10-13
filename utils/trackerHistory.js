const mysql = require('mysql2/promise');

/**
 * Utility functions for managing tracker history
 * Saves tracker status changes to the tracker_history table
 */

let pool;

/**
 * Initialize the tracker history utility with database pool
 * @param {mysql.Pool} dbPool - MySQL connection pool
 */
function initialize(dbPool) {
  pool = dbPool;
  console.log('✅ Tracker history utility initialized');
}

/**
 * Save a tracker status change to the tracker_history table
 * @param {Object} historyData - The history data to save
 * @param {string} historyData.tracker_id - Tracker device ID
 * @param {number} historyData.user_id - User ID who owns the tracker
 * @param {string} historyData.history_type - Type of status change (online, offline, geofence_in, geofence_out, nearby_pets, etc.)
 * @param {number} historyData.lat - Latitude coordinate
 * @param {number} historyData.lng - Longitude coordinate  
 * @param {number} [historyData.battery] - Battery level (optional)
 * @param {Date} [historyData.datetime] - Timestamp (defaults to current time)
 * @returns {Promise<boolean>} - Success status
 */
async function saveTrackerHistory(historyData) {
  if (!pool) {
    console.error('❌ Tracker history utility not initialized');
    return false;
  }

  let connection;
  try {
    const {
      tracker_id,
      user_id,
      history_type,
      lat,
      lng,
      battery = null,
      datetime = new Date()
    } = historyData;

    // Validate required fields
    if (!tracker_id || !user_id || !history_type || lat === undefined || lng === undefined) {
      console.error('❌ Missing required fields for tracker history:', {
        tracker_id,
        user_id,
        history_type,
        lat,
        lng
      });
      return false;
    }

    // Validate history_type - ONLY these 5 types are allowed
    const validHistoryTypes = [
      'online',
      'offline', 
      'geofence_in',
      'geofence_out',
      'nearby_pets'
    ];

    if (!validHistoryTypes.includes(history_type)) {
      console.error(`❌ Invalid history type: ${history_type}. Only allowed: ${validHistoryTypes.join(', ')}`);
      return false;
    }

    connection = await pool.getConnection();

    await connection.query(
      `INSERT INTO tracker_history (tracker_id, user_id, history_type, lat, lng, battery, datetime) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tracker_id, user_id, history_type, lat, lng, battery, datetime]
    );

    console.log(`📝 Tracker history saved: ${tracker_id} - ${history_type} at ${lat},${lng}`);
    return true;

  } catch (error) {
    console.error('❌ Error saving tracker history:', {
      message: error.message,
      code: error.code,
      historyData
    });
    return false;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

/**
 * Save multiple tracker history records in a batch
 * @param {Array<Object>} historyRecords - Array of history data objects
 * @returns {Promise<{success: number, failed: number}>} - Batch operation results
 */
async function saveTrackerHistoryBatch(historyRecords) {
  if (!pool) {
    console.error('❌ Tracker history utility not initialized');
    return { success: 0, failed: historyRecords.length };
  }

  if (!Array.isArray(historyRecords) || historyRecords.length === 0) {
    console.error('❌ Invalid history records array provided');
    return { success: 0, failed: 0 };
  }

  let connection;
  let success = 0;
  let failed = 0;

  try {
    connection = await pool.getConnection();
    
    // Prepare batch insert values
    const insertValues = [];
    const validRecords = [];

    for (const record of historyRecords) {
      const {
        tracker_id,
        user_id,
        history_type,
        lat,
        lng,
        battery = null,
        datetime = new Date()
      } = record;

      // Validate each record
      if (!tracker_id || !user_id || !history_type || lat === undefined || lng === undefined) {
        console.error('❌ Skipping invalid record in batch:', record);
        failed++;
        continue;
      }

      insertValues.push([tracker_id, user_id, history_type, lat, lng, battery, datetime]);
      validRecords.push(record);
    }

    if (insertValues.length === 0) {
      console.error('❌ No valid records to insert in batch');
      return { success: 0, failed };
    }

    // Execute batch insert
    await connection.query(
      `INSERT INTO tracker_history (tracker_id, user_id, history_type, lat, lng, battery, datetime) 
       VALUES ?`,
      [insertValues]
    );

    success = insertValues.length;
    console.log(`✅ Batch tracker history saved: ${success} records`);

  } catch (error) {
    console.error('❌ Error saving tracker history batch:', {
      message: error.message,
      code: error.code,
      recordCount: historyRecords.length
    });
    failed = historyRecords.length - success;
  } finally {
    if (connection) {
      connection.release();
    }
  }

  return { success, failed };
}

/**
 * Get tracker history for a specific tracker
 * @param {string} trackerId - Tracker device ID
 * @param {Object} [options] - Query options
 * @param {Date} [options.from] - Start date filter
 * @param {Date} [options.to] - End date filter
 * @param {string} [options.historyType] - Filter by history type
 * @param {number} [options.limit] - Limit number of results (default: 100)
 * @returns {Promise<Array>} - Array of history records
 */
async function getTrackerHistory(trackerId, options = {}) {
  if (!pool) {
    console.error('❌ Tracker history utility not initialized');
    return [];
  }

  let connection;
  try {
    const {
      from = null,
      to = null,
      historyType = null,
      limit = 100
    } = options;

    connection = await pool.getConnection();

    let query = `
      SELECT history_id, tracker_id, user_id, history_type, lat, lng, battery, datetime
      FROM tracker_history 
      WHERE tracker_id = ?
    `;
    const params = [trackerId];

    // Add optional filters
    if (from) {
      query += ` AND datetime >= ?`;
      params.push(from);
    }

    if (to) {
      query += ` AND datetime <= ?`;
      params.push(to);
    }

    if (historyType) {
      query += ` AND history_type = ?`;
      params.push(historyType);
    }

    query += ` ORDER BY datetime DESC LIMIT ?`;
    params.push(limit);

    const [rows] = await connection.query(query, params);
    
    console.log(`📊 Retrieved ${rows.length} history records for tracker ${trackerId}`);
    return rows;

  } catch (error) {
    console.error('❌ Error retrieving tracker history:', {
      message: error.message,
      trackerId,
      options
    });
    return [];
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

/**
 * Get recent tracker history across all trackers for a user
 * @param {number} userId - User ID
 * @param {Object} [options] - Query options
 * @param {number} [options.hours] - Hours to look back (default: 24)
 * @param {number} [options.limit] - Limit number of results (default: 50)
 * @returns {Promise<Array>} - Array of recent history records
 */
async function getRecentTrackerHistory(userId, options = {}) {
  if (!pool) {
    console.error('❌ Tracker history utility not initialized');
    return [];
  }

  let connection;
  try {
    const {
      hours = 24,
      limit = 50
    } = options;

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      SELECT th.history_id, th.tracker_id, th.user_id, th.history_type, 
             th.lat, th.lng, th.battery, th.datetime,
             t.pet_name, t.pet_type
      FROM tracker_history th
      LEFT JOIN trackers t ON th.tracker_id = t.device_id
      WHERE th.user_id = ? 
        AND th.datetime >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      ORDER BY th.datetime DESC 
      LIMIT ?
      `,
      [userId, hours, limit]
    );

    console.log(`📊 Retrieved ${rows.length} recent history records for user ${userId}`);
    return rows;

  } catch (error) {
    console.error('❌ Error retrieving recent tracker history:', {
      message: error.message,
      userId,
      options
    });
    return [];
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

module.exports = {
  initialize,
  saveTrackerHistory,
  saveTrackerHistoryBatch,
  getTrackerHistory,
  getRecentTrackerHistory
};