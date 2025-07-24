const pool = require('../server').pool;
let io = null;

function setSocketIO(ioInstance) {
  io = ioInstance;
}

async function emitNotification(notification) {
  if (io) {
    io.emit('notification', notification);
  }
}

async function saveNotificationToDB(notification) {
  if (!pool) throw new Error('MySQL pool not available');
  const { message, deviceId = null, userId = null } = notification;
  const createdAt = new Date();
  const read = 0;
  const conn = await pool.getConnection();
  try {
    await conn.query(
      `INSERT INTO notifications (message, device_id, user_id, created_at, is_read) VALUES (?, ?, ?, ?, ?)`,
      [message, deviceId, userId, createdAt, read]
    );
  } finally {
    conn.release();
  }
}

module.exports = {
  setSocketIO,
  emitNotification,
  saveNotificationToDB,
};
