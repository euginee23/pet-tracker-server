const mysql = require("mysql2/promise");
require("dotenv").config();

// Get the MySQL connection pool from server.js or create a new one
let pool;

/**
 * Initialize the notifications helper with a MySQL connection pool
 * @param {Object} connectionPool - MySQL connection pool from server.js
 */
function initialize(connectionPool) {
  pool = connectionPool;
}

/**
 * Create and emit a notification
 * @param {Object} io - Socket.io instance 
 * @param {Number} userId - User ID to associate the notification with
 * @param {String} deviceId - Device ID the notification is about
 * @param {String} message - Notification message
 * @param {String} soundType - Type of sound to play ('normal', 'alert', 'offline')
 * @returns {Object|null} The created notification or null if there was an error
 */
async function createNotification(io, userId, deviceId, message, soundType = 'normal') {
  if (!pool) {
    console.error('❌ Notification helper not initialized with a database pool');
    return null;
  }

  let connection;
  try {
    connection = await pool.getConnection();
    
    // Save to database
    const [result] = await connection.query(
      `INSERT INTO notifications (user_id, device_id, message, created_at, is_read) 
       VALUES (?, ?, ?, NOW(), 0)`,
      [userId, deviceId, message]
    );
    
    const notificationId = result.insertId;
    
    // Prepare notification object
    const notification = {
      id: notificationId,
      user_id: userId,
      device_id: deviceId,
      message,
      created_at: new Date().toISOString(),
      is_read: 0,
      sound_type: soundType 
    };
    
    // Emit to all connected clients
    io.emit('notification', notification);
    
    console.log(`📢 Notification created and emitted: ${message}`);
    return notification;
  } catch (err) {
    console.error('❌ Failed to create notification:', err);
    return null;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  initialize,
  createNotification
};
