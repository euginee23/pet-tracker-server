const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const axios = require("axios");
require("dotenv").config();

const isInsideGeofence = require("./utils/isInsideGeofence");
const { sendSMS } = require("./utils/sms");
const {
  sendOTPSMS,
  generateOTPCode,
  validateOTPCode,
} = require("./utils/otp_sms");
const notificationHelper = require("./utils/notifications");
const {
  getTrackerOwnerPhone,
  isNotificationEnabled,
} = require("./utils/userNotificationUtils");
const detectNearbyPets = require("./utils/detectNearbyPets");
const {
  getCachedUserId,
  cacheDeviceUser,
  clearCachedDevice
} = require("./utils/deviceCache");
const { executeWithRetry, queryWithRetry } = require("./utils/dbRetry");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// MIDDLEWARE
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// MYSQL CONNECTION POOL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

// DATABASE CONNECTION STARTUP CHECK
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("✅ Successfully connected to the database.");
    connection.release();
    notificationHelper.initialize(pool);
  } catch (err) {
    console.error("❌ Error connecting to the database:", err.message || err);
  }
})();

// NODEMAILER TRANSPORT
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const CHECK_INTERVAL = 30000;
let latestDevices = {};
let deviceStatus = {};

function getAllDevicesWithStatus() {
  const now = Date.now();
  return Object.entries(latestDevices).map(([deviceId, info]) => ({
    deviceId,
    lat: info.lat,
    lng: info.lng,
    battery: info.battery,
    lastSeen: info.lastSeen,
    isOnline: now - info.lastSeen <= CHECK_INTERVAL,
  }));
}

async function broadcastDevices() {
  try {
    const sockets = await io.fetchSockets();

    for (const socket of sockets) {
      const userId = socket.handshake.query.userId;
      if (userId) {
        try {
          const userDevices = await getUserDevices(userId);
          socket.emit("devices", userDevices);
        } catch (error) {
          console.error(`❌ Error sending devices to user ${userId}:`, error);
          socket.emit("devices", []);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error in broadcastDevices:", error);
  }
}

// GET USER SPECIFIC DEVICES
async function getUserDevices(userId) {
  try {
    const connection = await pool.getConnection();
    const [trackers] = await connection.query(
      "SELECT device_id FROM trackers WHERE user_id = ?",
      [userId]
    );

    const [allAssignedTrackers] = await connection.query(
      "SELECT device_id FROM trackers"
    );
    connection.release();

    const userDeviceIds = trackers.map((t) => t.device_id);
    const assignedDeviceIds = allAssignedTrackers.map((t) => t.device_id);
    const allDevices = getAllDevicesWithStatus();

    return allDevices.filter(
      (device) =>
        userDeviceIds.includes(device.deviceId) ||
        (!assignedDeviceIds.includes(device.deviceId) && device.isOnline)
    );
  } catch (error) {
    console.error("❌ Error getting user devices:", error);
    return [];
  }
}

// SOCKET CONNECTION
io.on("connection", async (socket) => {
  console.log("🔌 Client connected via Socket.IO");

  const userId = socket.handshake.query.userId;
  if (!userId) {
    console.error("❌ Missing userId in Socket.IO connection");
    socket.disconnect();
    return;
  }

  socket.join(userId);
  console.log(`🔒 User ${userId} joined their room`);

  try {
    const userDevices = await getUserDevices(userId);
    socket.emit("devices", userDevices);
    console.log(`📡 Sent ${userDevices.length} devices to user ${userId}`);
  } catch (error) {
    console.error(`❌ Error sending devices to user ${userId}:`, error);
    socket.emit("devices", []);
  }

  socket.on("disconnect", () => {
    console.log(`❌ User ${userId} disconnected`);
  });
});

// DEVICE SENDS DATA
app.post("/data", async (req, res) => {
  let connection;
  try {
    const now = Date.now();
    const data = req.body;

    if (!data || typeof data !== "object" || !data.deviceId) {
      console.log("⚠️ Received invalid or empty JSON");
      return res.status(400).send("Invalid JSON payload");
    }
    
    if (!data.userId) {
      const cachedUserId = getCachedUserId(data.deviceId);
      
      if (cachedUserId) {
        data.userId = cachedUserId;
      } else {
        try {
          const trackerInfo = await queryWithRetry(
            pool,
            `SELECT user_id FROM trackers WHERE device_id = ? LIMIT 1`,
            [data.deviceId]
          );
          
          if (trackerInfo.length > 0) {
            data.userId = trackerInfo[0].user_id;
            cacheDeviceUser(data.deviceId, data.userId);
            console.log(`ℹ️ Found and cached userId ${data.userId} for device ${data.deviceId}`);
          } else {
            console.log(`⚠️ No userId found for device ${data.deviceId}`);
          }
        } catch (lookupError) {
          console.error(`❌ Error looking up userId for device ${data.deviceId}:`, lookupError.message);
        }
      }
    }

    const prevState = latestDevices[data.deviceId] || {};

    latestDevices[data.deviceId] = {
      lat: data.lat,
      lng: data.lng,
      battery: data.battery,
      lastSeen: now,
      online: true,
      userId: data.userId,
    };

    if (
      data.battery !== undefined &&
      data.battery <= 20 &&
      (prevState.battery === undefined || prevState.battery > 20)
    ) {
      try {
        let batteryConnection = await pool.getConnection();
        const [trackers] = await batteryConnection.query(
          `SELECT user_id, pet_name FROM trackers WHERE device_id = ?`,
          [data.deviceId]
        );
        batteryConnection.release();

        for (const tracker of trackers) {
          const userId = tracker.user_id;
          const petName = tracker.pet_name || "Your pet";

          await notificationHelper.createNotification(
            io,
            userId,
            data.deviceId,
            `⚠️ ${petName}'s tracker battery is low (${data.battery}%)`,
            "alert"
          );

          // SMS NOTIFICATION FOR LOW BATTERY
          try {
            console.log(
              `🔋 Checking low battery notification settings for user ${userId}`
            );

            let settingsConn = await pool.getConnection();
            const [settings] = await settingsConn.query(
              `SELECT * FROM sms_notification_settings WHERE user_id = ?`,
              [userId]
            );
            settingsConn.release();

            if (settings.length > 0) {
              console.log(
                `📋 Raw low battery settings from database for user ${userId}:`,
                JSON.stringify(settings[0])
              );
            } else {
              console.log(`⚠️ No SMS settings found for user ${userId}`);
              continue;
            }

            const notificationEnabled = await isNotificationEnabled(
              pool,
              userId,
              "low_battery"
            );

            if (!notificationEnabled) {
              console.log(
                `ℹ️ User ${userId} has disabled SMS notifications for low battery events`
              );
              continue;
            } else {
              console.log(
                `✅ User ${userId} has enabled SMS notifications for low battery events`
              );
            }

            const { phoneNumber } = await getTrackerOwnerPhone(
              pool,
              data.deviceId
            );

            if (!phoneNumber) {
              console.warn(
                `⚠️ No valid phone number for user ${userId}, skipping SMS notification`
              );
              continue;
            }

            console.log(
              `📱 Sending SMS for low battery: ${petName}'s tracker at ${data.battery}% to ${phoneNumber}`
            );

            const smsResponse = await sendSMS(
              phoneNumber,
              `⚠️ ALERT: ${petName}'s tracker battery is low (${
                data.battery
              }%). Please charge soon. Time: ${new Date().toLocaleString()}`
            );

            console.log(`✅ SMS sent for low battery`, smsResponse);
          } catch (smsError) {
            console.error(
              `❌ Failed to send SMS for low battery:`,
              smsError.message
            );
          }
        }
      } catch (batteryError) {
        console.error(
          `❌ Error processing low battery notification:`,
          batteryError.message
        );
      }
    }

    if (deviceStatus[data.deviceId] !== "online") {
      console.log(`🟢 ${data.deviceId} is now ONLINE`);
      deviceStatus[data.deviceId] = "online";

      try {
        connection = await pool.getConnection();
        const [trackers] = await connection.query(
          `SELECT user_id, pet_name FROM trackers WHERE device_id = ?`,
          [data.deviceId]
        );
        connection.release();

        for (const tracker of trackers) {
          const petName = tracker.pet_name || "Your pet";
          const message = `${petName}'s tracker (${data.deviceId}) is now ONLINE`;

          await notificationHelper.createNotification(
            io,
            tracker.user_id,
            data.deviceId,
            message,
            "normal"
          );
        }

        // SMS NOTIFICATION FOR DEVICE ONLINE STATUS
        try {
          for (const tracker of trackers) {
            const userId = tracker.user_id;

            console.log(
              `🔎 Checking online notification settings for user ${userId} and device ${data.deviceId}`
            );

            let connection = await pool.getConnection();
            const [settings] = await connection.query(
              `SELECT * FROM sms_notification_settings WHERE user_id = ?`,
              [userId]
            );
            connection.release();

            if (settings.length > 0) {
              console.log(
                `📋 Raw settings from database for user ${userId}:`,
                JSON.stringify(settings[0])
              );
            } else {
              console.log(`⚠️ No SMS settings found for user ${userId}`);
              continue;
            }

            const notificationEnabled = await isNotificationEnabled(
              pool,
              userId,
              "online"
            );

            if (!notificationEnabled) {
              console.log(
                `ℹ️ User ${userId} has disabled SMS notifications for online events`
              );
              continue;
            } else {
              console.log(
                `✅ User ${userId} has enabled SMS notifications for online events`
              );
            }

            const { phoneNumber } = await getTrackerOwnerPhone(
              pool,
              data.deviceId
            );

            if (!phoneNumber) {
              console.warn(
                `⚠️ No valid phone number for user ${userId}, skipping SMS notification`
              );
              continue;
            }

            const petName = tracker.pet_name || "Your pet";
            console.log(
              `📱 Sending SMS notification for ${data.deviceId} going online to ${phoneNumber}`
            );

            const smsResponse = await sendSMS(
              phoneNumber,
              `${petName}'s tracker (${
                data.deviceId
              }) is now ONLINE. Time: ${new Date().toLocaleString()}`
            );

            console.log(
              `✅ SMS notification sent for device ${data.deviceId}`,
              smsResponse
            );
          }
        } catch (smsError) {
          console.error(
            `❌ Failed to send SMS notification:`,
            smsError.message
          );
        }
      } catch (notifError) {
        console.error(`❌ Error creating online notification:`, notifError);
      }
    }

    if (!global.lastGeofenceState) global.lastGeofenceState = {};
    const lastState = global.lastGeofenceState[data.deviceId] || [];

    const geofences = await queryWithRetry(
      pool,
      `
      SELECT g.*
      FROM geofences g
      JOIN geofence_assignment ga ON g.geofence_id = ga.geofence_id
      WHERE ga.device_id = ?
      `,
      [data.deviceId]
    );

    if (geofences.length === 0) {
      console.log(
        `ℹ️ No geofences set for ${data.deviceId}. Skipping geofence check.`
      );
    } else {
      if (!global.lastGeofenceState) global.lastGeofenceState = {};
      const lastState = global.lastGeofenceState[data.deviceId] || [];

      const insideGeofences = [];
      const geofenceDistances = [];
      for (const geofence of geofences) {
        const result = isInsideGeofence(data.lat, data.lng, [geofence]);
        if (result.isInside) {
          insideGeofences.push(geofence.geofence_id);
        }
        geofenceDistances.push({
          geofenceId: geofence.geofence_id,
          geofenceName: geofence.geofence_name || geofence.geofence_id,
          distance: result.distance,
        });
      }

      // GET PET NAME FOR NOTIFICATIONS
      const trackerInfo = await queryWithRetry(
        pool,
        `SELECT user_id, pet_name FROM trackers WHERE device_id = ?`,
        [data.deviceId]
      );

      for (const geofence of geofences) {
        const geofenceId = geofence.geofence_id;
        const geofenceName = geofence.geofence_name || geofenceId;
        const wasInside = lastState.includes(geofenceId);
        const isNowInside = insideGeofences.includes(geofenceId);
        const distObj = geofenceDistances.find(
          (gd) => gd.geofenceId === geofenceId
        );

        for (const tracker of trackerInfo) {
          const petName = tracker.pet_name || "Your pet";

          if (!wasInside && isNowInside) {
            console.log(
              `✅ Pet ${data.deviceId} is now inside geofence (${geofenceName})`
            );

            await notificationHelper.createNotification(
              io,
              tracker.user_id,
              data.deviceId,
              `${petName} has entered the "${geofenceName}" geofence zone`,
              "normal"
            );

            // SMS NOTIFICATION FOR GEOFENCE ENTRY
            try {
              const userId = tracker.user_id;
              console.log(
                `🔎 Checking geofence entry notification settings for user ${userId}`
              );

              let settingsConn = await pool.getConnection();
              const [settings] = await settingsConn.query(
                `SELECT * FROM sms_notification_settings WHERE user_id = ?`,
                [userId]
              );
              settingsConn.release();

              if (settings.length > 0) {
                console.log(
                  `📋 Raw geofence entry settings from database for user ${userId}:`,
                  JSON.stringify(settings[0])
                );
              } else {
                console.log(`⚠️ No SMS settings found for user ${userId}`);
                continue;
              }

              const notificationEnabled = await isNotificationEnabled(
                pool,
                userId,
                "in_geofence"
              );

              if (!notificationEnabled) {
                console.log(
                  `ℹ️ User ${userId} has disabled SMS notifications for geofence entry events`
                );
                continue;
              } else {
                console.log(
                  `✅ User ${userId} has enabled SMS notifications for geofence entry events`
                );
              }

              const { phoneNumber } = await getTrackerOwnerPhone(
                pool,
                data.deviceId
              );

              if (!phoneNumber) {
                console.warn(
                  `⚠️ No valid phone number for user ${userId}, skipping SMS notification`
                );
                continue;
              }

              console.log(
                `📱 Sending SMS for geofence entry: ${petName} entered ${geofenceName} to ${phoneNumber}`
              );

              const smsResponse = await sendSMS(
                phoneNumber,
                `${petName} has ENTERED the "${geofenceName}" geofence zone. Time: ${new Date().toLocaleString()}`
              );

              console.log(`✅ SMS sent for geofence entry`, smsResponse);
            } catch (smsError) {
              console.error(
                `❌ Failed to send SMS for geofence entry:`,
                smsError.message
              );
            }
          } else if (wasInside && isNowInside) {
            console.log(
              `✅ Pet ${data.deviceId} is inside geofence (${geofenceName})`
            );
          } else if (wasInside && !isNowInside) {
            console.warn(
              `⚠️ Pet ${
                data.deviceId
              } is now outside geofence (${geofenceName}) (~${distObj.distance.toFixed(
                2
              )}m away)`
            );

            // "LEFT GEOFENCE" NOTIFICATION
            await notificationHelper.createNotification(
              io,
              tracker.user_id,
              data.deviceId,
              `⚠️ ${petName} has left the "${geofenceName}" geofence zone!`,
              "alert"
            );

            // SMS NOTIFICATION FOR GEOFENCE EXIT
            try {
              const userId = tracker.user_id;
              console.log(
                `🔎 Checking geofence exit notification settings for user ${userId}`
              );

              let settingsConn = await pool.getConnection();
              const [settings] = await settingsConn.query(
                `SELECT * FROM sms_notification_settings WHERE user_id = ?`,
                [userId]
              );
              settingsConn.release();

              if (settings.length > 0) {
                console.log(
                  `📋 Raw geofence exit settings from database for user ${userId}:`,
                  JSON.stringify(settings[0])
                );
              } else {
                console.log(`⚠️ No SMS settings found for user ${userId}`);
                continue;
              }

              const notificationEnabled = await isNotificationEnabled(
                pool,
                userId,
                "out_geofence"
              );

              if (!notificationEnabled) {
                console.log(
                  `ℹ️ User ${userId} has disabled SMS notifications for geofence exit events`
                );
                continue;
              } else {
                console.log(
                  `✅ User ${userId} has enabled SMS notifications for geofence exit events`
                );
              }

              const { phoneNumber } = await getTrackerOwnerPhone(
                pool,
                data.deviceId
              );

              if (!phoneNumber) {
                console.warn(
                  `⚠️ No valid phone number for user ${userId}, skipping SMS notification`
                );
                continue;
              }

              console.log(
                `📱 Sending SMS for geofence exit: ${petName} left ${geofenceName} to ${phoneNumber}`
              );

              const smsResponse = await sendSMS(
                phoneNumber,
                `⚠️ ALERT: ${petName} has LEFT the "${geofenceName}" geofence zone! Time: ${new Date().toLocaleString()}`
              );

              console.log(`✅ SMS sent for geofence exit`, smsResponse);
            } catch (smsError) {
              console.error(
                `❌ Failed to send SMS for geofence exit:`,
                smsError.message
              );
            }
          }
        }
      }

      if (insideGeofences.length === 0) {
        const distMsg = geofenceDistances
          .map((gd) => `${gd.geofenceName} ~${gd.distance.toFixed(2)}m`)
          .join(", ");
        console.warn(
          `⚠️ Pet ${data.deviceId} is now outside all geofences: ${distMsg}`
        );
      }

      global.lastGeofenceState[data.deviceId] = insideGeofences;
    }

    if (data.userId) {
      if (!global.lastNearbyPetsState) {
        global.lastNearbyPetsState = {};
      }

      if (!global.lastNearbyPetsState[data.deviceId]) {
        global.lastNearbyPetsState[data.deviceId] = [];
      }

      const currentPet = {
        lat: data.lat,
        lng: data.lng,
        userId: data.userId,
        deviceId: data.deviceId,
      };

      const otherPets = Object.entries(latestDevices)
        .filter(([deviceId]) => deviceId !== data.deviceId)
        .map(([deviceId, device]) => ({
          deviceId,
          lat: device.lat,
          lng: device.lng,
          userId: device.userId,
        }));

      let detectionRadius = 10; 
      try {
        const userSettings = await queryWithRetry(
          pool,
          `SELECT meter_radius FROM sms_notification_settings WHERE user_id = ?`,
          [data.userId]
        );
        
        if (userSettings.length > 0 && userSettings[0].meter_radius) {
          detectionRadius = parseInt(userSettings[0].meter_radius) || 10;
          console.log(
            `📏 Using configured detection radius: ${detectionRadius}m for user ${data.userId}`
          );
        } else {
          console.log(
            `📏 Using default detection radius: ${detectionRadius}m for user ${data.userId}`
          );
        }
      } catch (radiusError) {
        console.error(`❌ Error getting detection radius for user ${data.userId}:`, radiusError.message);
        console.log(
          `📏 Using default detection radius: ${detectionRadius}m for user ${data.userId}`
        );
      }

      const nearbyPetsResult = detectNearbyPets(
        currentPet,
        otherPets,
        detectionRadius
      );

      if (nearbyPetsResult.length > 0) {
        try {
          const nearbyDeviceIds = nearbyPetsResult.map((pet) => pet.deviceId);
          const allDeviceIds = [data.deviceId, ...nearbyDeviceIds];

          const ownerInfo = await queryWithRetry(
            pool,
            `SELECT t.device_id, t.user_id, t.pet_name, t.pet_type, t.pet_breed, u.first_name, u.last_name, u.email 
             FROM trackers t 
             JOIN users u ON t.user_id = u.user_id 
             WHERE t.device_id IN (?)`,
            [allDeviceIds]
          );

          const ownerGroups = {};
          const deviceOwnerMap = {};

          ownerInfo.forEach((tracker) => {
            const userId = tracker.user_id;
            const deviceId = tracker.device_id;
            const petName = tracker.pet_name || "Unnamed Pet";
            const petType = tracker.pet_type || "Unknown";
            const petBreed = tracker.pet_breed || "Unknown";
            const ownerName =
              `${tracker.first_name || ""} ${tracker.last_name || ""}`.trim() ||
              tracker.email ||
              `User ${userId}`;

            const deviceCoords =
              deviceId === data.deviceId
                ? { lat: data.lat, lng: data.lng }
                : nearbyPetsResult.find((pet) => pet.deviceId === deviceId);

            deviceOwnerMap[deviceId] = {
              userId,
              petName,
              petType,
              petBreed,
              ownerName,
            };

            if (!ownerGroups[userId]) {
              ownerGroups[userId] = [];
            }
            ownerGroups[userId].push({
              deviceId,
              petName,
              petType,
              petBreed,
              lat: deviceCoords?.lat,
              lng: deviceCoords?.lng,
              owner: { userId, petName, petType, petBreed, ownerName },
            });
          });

          const involvedUserIds = Object.keys(ownerGroups);

          if (involvedUserIds.length > 1) {
            console.log(
              `🐾 Nearby pets detected from different owners (within ${detectionRadius}m):`,
              ownerGroups
            );

            const shouldGroupPets = Object.values(ownerGroups).some(
              (pets) => pets.length > 1
            );

            let nearbyPetsData;

            if (shouldGroupPets) {
              nearbyPetsData = {
                type: "grouped",
                involvedUsers: involvedUserIds,
                ownerGroups: ownerGroups,
                triggerDevice: {
                  deviceId: data.deviceId,
                  owner: deviceOwnerMap[data.deviceId],
                  lat: data.lat,
                  lng: data.lng,
                },
                nearbyDevices: nearbyPetsResult.map((pet) => ({
                  deviceId: pet.deviceId,
                  lat: pet.lat,
                  lng: pet.lng,
                  owner: deviceOwnerMap[pet.deviceId],
                })),
              };
            } else {
              const allPets = [];

              allPets.push({
                deviceId: data.deviceId,
                petName:
                  deviceOwnerMap[data.deviceId]?.petName || "Unnamed Pet",
                petType: deviceOwnerMap[data.deviceId]?.petType || "Unknown",
                petBreed: deviceOwnerMap[data.deviceId]?.petBreed || "Unknown",
                userId: deviceOwnerMap[data.deviceId]?.userId,
                ownerName:
                  deviceOwnerMap[data.deviceId]?.ownerName ||
                  `User ${deviceOwnerMap[data.deviceId]?.userId}`,
                lat: data.lat,
                lng: data.lng,
                isTrigger: true,
              });

              nearbyPetsResult.forEach((pet) => {
                allPets.push({
                  deviceId: pet.deviceId,
                  petName:
                    deviceOwnerMap[pet.deviceId]?.petName || "Unnamed Pet",
                  petType: deviceOwnerMap[pet.deviceId]?.petType || "Unknown",
                  petBreed: deviceOwnerMap[pet.deviceId]?.petBreed || "Unknown",
                  userId: deviceOwnerMap[pet.deviceId]?.userId,
                  ownerName:
                    deviceOwnerMap[pet.deviceId]?.ownerName ||
                    `User ${deviceOwnerMap[pet.deviceId]?.userId}`,
                  lat: pet.lat,
                  lng: pet.lng,
                  isTrigger: false,
                });
              });

              nearbyPetsData = {
                type: "individual",
                involvedUsers: involvedUserIds,
                pets: allPets,
              };
            }

      if (!global.nearbyPetsInteractions) {
        global.nearbyPetsInteractions = {};
      }
      
      const allInvolvedDeviceIds = [...nearbyDeviceIds, data.deviceId].sort();
      const interactionKey = allInvolvedDeviceIds.join(',');
      
      const hasNotifiedBefore = global.nearbyPetsInteractions[interactionKey] === true;
      
      involvedUserIds.forEach((userId) => {
        io.to(userId).emit("nearby-pets", nearbyPetsData);
      });
      
      if (!hasNotifiedBefore) {
        global.nearbyPetsInteractions[interactionKey] = true;
        
        console.log(`✨ New nearby pets interaction detected (${interactionKey}), sending notifications`);
        
        let userSettings = {};
        try {
          const userSettingsResult = await queryWithRetry(
            pool,
            `SELECT u.user_id, u.phone, s.nearby_pet as nearby_pet_enabled 
             FROM users u
             LEFT JOIN sms_notification_settings s ON u.user_id = s.user_id
             WHERE u.user_id IN (?)`,
            [involvedUserIds]
          );
          
          userSettingsResult.forEach(user => {
            userSettings[user.user_id] = {
              phoneNumber: user.phone,
              nearbyPetsEnabled: user.nearby_pet_enabled === 1
            };
          });
          
          console.log(`📊 Retrieved settings for ${Object.keys(userSettings).length} users`);
        } catch (settingsError) {
          console.error(`❌ Error getting user notification settings:`, settingsError.message);
        }
        
        for (const userId of involvedUserIds) {

          let notificationMessage = "";
          const currentUserPets = ownerGroups[userId] || [];
          const otherOwners = involvedUserIds.filter(id => id !== userId);
          
          const userPetNames = currentUserPets.map(pet => pet.petName).join(", ");
          
          const nearbyPetsCount = Object.entries(ownerGroups)
            .filter(([ownerId]) => ownerId !== userId)
            .reduce((total, [_, pets]) => total + pets.length, 0);
          
          if (nearbyPetsCount === 1) {
            const otherPet = Object.values(ownerGroups)
              .flat()
              .find(pet => pet.owner.userId !== userId);
              
            notificationMessage = `${userPetNames} is near ${otherPet.petName} (${otherPet.petType || 'pet'})`;
          } else {
            notificationMessage = `${userPetNames} is near ${nearbyPetsCount} other pets`;
          }
          
          await notificationHelper.createNotification(
            io,
            userId,
            data.deviceId,
            notificationMessage,
            "normal"
          );
          
          console.log(
            `📱 Notifying user ${userId} about nearby pets (${nearbyPetsData.type})`
          );
          
          try {
            const userSetting = userSettings[userId] || {};
            console.log(`🔎 Checking nearby pets SMS notification settings for user ${userId}`);
            
            const notificationEnabled = userSetting.nearbyPetsEnabled || 
              await isNotificationEnabled(pool, userId, "nearby_pet");
            
            if (!notificationEnabled) {
              console.log(
                `ℹ️ User ${userId} has disabled SMS notifications for nearby pets events`
              );
              continue;
            }
            
            const phoneNumber = userSetting.phoneNumber || 
              (await getTrackerOwnerPhone(pool, ownerGroups[userId][0].deviceId)).phoneNumber;
            
            if (!phoneNumber) {
              console.warn(
                `⚠️ No valid phone number for user ${userId}, skipping SMS notification`
              );
              continue;
            }
            
            const userPetNames = currentUserPets.map(pet => pet.petName).join(", ");
            const otherOwnerPets = Object.entries(ownerGroups)
              .filter(([ownerId]) => ownerId !== userId)
              .map(([_, pets]) => pets)
              .flat();
            
            let smsMessage = "";
            if (otherOwnerPets.length === 1) {
              smsMessage = `${userPetNames} is near ${otherOwnerPets[0].petName} (${otherOwnerPets[0].petType || 'pet'}) within ${detectionRadius}m. Time: ${new Date().toLocaleString()}`;
            } else {
              smsMessage = `${userPetNames} is near ${otherOwnerPets.length} other pets within ${detectionRadius}m. Time: ${new Date().toLocaleString()}`;
            }
            
            console.log(
              `📱 Sending SMS for nearby pets detection to ${phoneNumber}`
            );
            
            const smsResponse = await sendSMS(
              phoneNumber,
              smsMessage
            );
            
            console.log(`✅ SMS sent for nearby pets`, smsResponse);
          } catch (smsError) {
            console.error(
              `❌ Failed to send SMS for nearby pets to user ${userId}:`,
              smsError.message
            );
          }
        }
            } else {
              console.log(`ℹ️ Interaction between pets already notified before (${interactionKey}), skipping notifications and SMS`);
            }
          }
        } catch (nearbyError) {
          console.error(
            `❌ Error processing nearby pets detection:`,
            nearbyError.message
          );
        }
      } else {
        const previousNearby = global.lastNearbyPetsState[data.deviceId] || [];
        if (previousNearby.length > 0) {
          console.log(`📍 Pets are no longer nearby for device ${data.deviceId}`);
          global.lastNearbyPetsState[data.deviceId] = [];
          
          // (OPTIONAL: ADD FEATURE IF NEARBY PETS IS NO LONGER NEARBY)
        }
      }
    } else {
      console.log(
        `ℹ️ Skipping nearby pets detection for unassigned device ${data.deviceId}`
      );
    }

    console.log("📥 Received from device:", data);
    broadcastDevices();
    res.status(200).send("✅ Data received");
  } catch (err) {
    const isConnectionError = 
      err.code === 'ECONNRESET' || 
      err.code === 'PROTOCOL_CONNECTION_LOST' ||
      err.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
      err.code === 'ETIMEDOUT';
    
    console.error("❌ Error handling /data:", {
      message: err.message,
      code: err.code || 'unknown',
      isConnectionError,
      stack: err.stack
    });
    
    if (isConnectionError) {
      console.log("🔄 Responding with temporary error for connection issue - device should retry");
      res.status(503).send("Database connection error - please retry");
    } else {
      res.status(500).send("Server error");
    }
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (releaseError) {
        console.warn("⚠️ Error releasing connection:", releaseError.message);
      }
    }
  }
});

// DEVICE GOES OFFLINE
setInterval(() => {
  const now = Date.now();

  for (const [deviceId, info] of Object.entries(latestDevices)) {
    const isOffline = now - info.lastSeen > CHECK_INTERVAL;
    if (isOffline && deviceStatus[deviceId] !== "offline") {
      console.log(`🔴 ${deviceId} is now OFFLINE`);
      deviceStatus[deviceId] = "offline";

      (async () => {
        let connection;
        try {
          connection = await pool.getConnection();

          // TRACKER LAST KNOWN DATA
          await connection.query(
            `UPDATE trackers 
         SET last_battery = ?, last_lat = ?, last_lng = ?, last_seen = NOW()
         WHERE device_id = ?`,
            [info.battery ?? null, info.lat ?? null, info.lng ?? null, deviceId]
          );
          console.log(
            `📦 Saved last known data for ${deviceId} (Battery: ${info.battery}%)`
          );

          // TRACKER OWNER
          const [trackers] = await connection.query(
            `SELECT user_id, pet_name FROM trackers WHERE device_id = ?`,
            [deviceId]
          );

          // CREATE NONTIF
          for (const tracker of trackers) {
            const petName = tracker.pet_name || "Your pet";
            const message = `${petName}'s tracker (${deviceId}) has gone OFFLINE`;

            await notificationHelper.createNotification(
              io,
              tracker.user_id,
              deviceId,
              message,
              "offline"
            );
          }

          // SMS NOTIFICATION FOR DEVICE OFFLINE STATUS
          try {
            for (const tracker of trackers) {
              const userId = tracker.user_id;

              console.log(
                `🔎 Checking offline notification settings for user ${userId} and device ${deviceId}`
              );

              // RAW NOTIFICATION SETTINGS
              let settingsConn = await pool.getConnection();
              const [settings] = await settingsConn.query(
                `SELECT * FROM sms_notification_settings WHERE user_id = ?`,
                [userId]
              );
              settingsConn.release();

              if (settings.length > 0) {
                console.log(
                  `📋 Raw settings from database for user ${userId}:`,
                  JSON.stringify(settings[0])
                );
              } else {
                console.log(`⚠️ No SMS settings found for user ${userId}`);
                continue;
              }

              const notificationEnabled = await isNotificationEnabled(
                pool,
                userId,
                "offline"
              );

              if (!notificationEnabled) {
                console.log(
                  `ℹ️ User ${userId} has disabled SMS notifications for offline events`
                );
                continue;
              } else {
                console.log(
                  `✅ User ${userId} has enabled SMS notifications for offline events`
                );
              }

              const { phoneNumber } = await getTrackerOwnerPhone(
                pool,
                deviceId
              );

              if (!phoneNumber) {
                console.warn(
                  `⚠️ No valid phone number for user ${userId}, skipping SMS notification`
                );
                continue;
              }

              const petName = tracker.pet_name || "Your pet";
              console.log(
                `📱 Sending SMS notification for ${deviceId} going offline to ${phoneNumber}`
              );

              const smsResponse = await sendSMS(
                phoneNumber,
                `${petName}'s tracker (${deviceId}) has gone OFFLINE. Time: ${new Date().toLocaleString()}`
              );

              console.log(
                `✅ SMS notification sent for offline device ${deviceId}`,
                smsResponse
              );
            }
          } catch (smsError) {
            console.error(
              `❌ Failed to send SMS notification for offline device:`,
              smsError.message
            );
          }
        } catch (err) {
          console.error(
            `❌ Failed to process offline device ${deviceId}:`,
            err.message
          );
        } finally {
          if (connection) connection.release();
        }
      })();
    }
  }

  broadcastDevices();
}, 20000);

// SIMULATION LOGIC
let simulationIntervals = {};
let simulatedDevices = {};
const MEETUP_POINT = { lat: 8.092, lng: 123.49 };

function startSimulation(deviceId, batteryOverride = null) {
  if (simulationIntervals[deviceId]) return;

  const angle = Math.random() * 2 * Math.PI;
  const distance = 0.0005 + Math.random() * 0.0005;
  simulatedDevices[deviceId] = {
    angle,
    position: {
      lat: MEETUP_POINT.lat + Math.cos(angle) * distance,
      lng: MEETUP_POINT.lng + Math.sin(angle) * distance,
    },
  };

  simulationIntervals[deviceId] = setInterval(async () => {
    const device = simulatedDevices[deviceId];

    const dx = MEETUP_POINT.lng - device.position.lng;
    const dy = MEETUP_POINT.lat - device.position.lat;
    const distanceToMeetup = Math.sqrt(dx * dx + dy * dy);

    const speed = 0.00002;
    device.position.lng += (dx / distanceToMeetup) * speed;
    device.position.lat += (dy / distanceToMeetup) * speed;

    const batteryLevel = batteryOverride ?? Math.floor(50 + Math.random() * 50);

    const payload = {
      deviceId,
      lat: device.position.lat,
      lng: device.position.lng,
      battery: batteryLevel,
    };

    try {
      await axios.post(process.env.SERVER_URL + `/data`, payload);
    } catch (err) {
      console.error(
        `❌ Failed to send simulated data for ${deviceId}:`,
        err.message
      );
    }
  }, 5000);

  console.log(`▶️ Started simulation for ${deviceId}`);
}

function stopSimulation(deviceId) {
  if (simulationIntervals[deviceId]) {
    clearInterval(simulationIntervals[deviceId]);
    delete simulationIntervals[deviceId];
    delete simulatedDevices[deviceId];
    console.log(`🛑 Stopped simulation for ${deviceId}`);
  }
}

// SIMULATE MULTIPLE DEVICES
app.post("/simulate-movement", (req, res) => {
  const { deviceIds, start = true, battery = null } = req.body;

  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return res
      .status(400)
      .json({ message: "deviceIds must be a non-empty array" });
  }

  if (start) {
    deviceIds.forEach((id) => startSimulation(id, battery));
    return res.status(200).json({
      message: `Started simulation for: ${deviceIds.join(", ")}`,
    });
  } else {
    deviceIds.forEach((id) => stopSimulation(id));
    return res.status(200).json({
      message: `Stopped simulation for: ${deviceIds.join(", ")}`,
    });
  }
});

// SAVE TRACKER
app.post("/api/trackers", async (req, res) => {
  let connection;
  try {
    const { device_id, user_id, pet_name, pet_image, pet_type, pet_breed } =
      req.body;

    if (!device_id || !user_id || !pet_name || !pet_type || !pet_breed) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    
    // Cache the device-user relationship to avoid DB lookups
    cacheDeviceUser(device_id, user_id);

    let imageBuffer = null;
    if (pet_image && typeof pet_image === "string") {
      const base64Data = pet_image.includes("base64,")
        ? pet_image.split("base64,")[1]
        : pet_image;
      imageBuffer = Buffer.from(base64Data, "base64");
    }

    connection = await pool.getConnection();

    await connection.query(
      `
      INSERT INTO trackers (
        device_id, user_id, pet_name, pet_image, pet_type, pet_breed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    `,
      [device_id, user_id, pet_name, imageBuffer, pet_type, pet_breed]
    );

    return res.status(201).json({ message: "Tracker saved successfully" });
  } catch (err) {
    console.error("❌ Error saving tracker:", err.message);
    return res.status(500).json({ message: "Failed to save tracker" });
  } finally {
    if (connection) connection.release();
  }
});

// GET ALL TRACKERS FOR A USER
app.get("/api/trackers/:userId", async (req, res) => {
  let connection;
  try {
    const { userId } = req.params;

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT device_id, pet_name, pet_type, pet_breed, 
              TO_BASE64(pet_image) AS pet_image,
              COALESCE(last_lat, 0) AS last_lat,
              COALESCE(last_lng, 0) AS last_lng,
              COALESCE(last_battery, 0) AS last_battery
       FROM trackers 
       WHERE user_id = ?`,
      [userId]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error("❌ Error fetching trackers:", err.message);
    res.status(500).json({ message: "Failed to fetch trackers" });
  } finally {
    if (connection) connection.release();
  }
});

// UPDATE TRACKER
app.put("/api/update-tracker", async (req, res) => {
  let connection;
  try {
    const { deviceId, userId, petName, petType, petBreed, petImage } = req.body;

    if (!deviceId || !userId || !petName) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let imageBuffer = null;
    if (petImage && typeof petImage === "string") {
      const base64Data = petImage.includes("base64,")
        ? petImage.split("base64,")[1]
        : petImage;

      imageBuffer = Buffer.from(base64Data, "base64");
    }

    connection = await pool.getConnection();

    const [existingTracker] = await connection.query(
      "SELECT device_id FROM trackers WHERE device_id = ? AND user_id = ?",
      [deviceId, userId]
    );

    if (existingTracker.length === 0) {
      return res.status(404).json({ message: "Tracker not found" });
    }

    let query = `UPDATE trackers SET 
                  pet_name = ?, 
                  pet_type = ?, 
                  pet_breed = ?`;

    let params = [petName, petType, petBreed];

    if (imageBuffer !== null) {
      query += `, pet_image = ?`;
      params.push(imageBuffer);
    }

    query += ` WHERE device_id = ? AND user_id = ?`;
    params.push(deviceId, userId);

    const [result] = await connection.query(query, params);

    if (result.affectedRows > 0) {
      console.log(`✅ Updated tracker ${deviceId} for user ${userId}`);
      return res.status(200).json({
        message: "Tracker updated successfully",
        success: true,
      });
    } else {
      console.log(`⚠️ No changes made to tracker ${deviceId}`);
      return res.status(200).json({
        message: "No changes were made to the tracker",
        success: true,
      });
    }
  } catch (err) {
    console.error("❌ Error updating tracker:", err.message);
    return res.status(500).json({ message: "Failed to update tracker" });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE TRACKER
app.delete("/api/trackers/:deviceId", async (req, res) => {
  let connection;
  try {
    const { deviceId } = req.params;
    const userId = req.body?.userId || req.query?.userId;

    console.log("DELETE tracker request:", {
      deviceId,
      userId,
      bodyUserId: req.body?.userId,
      queryUserId: req.query?.userId,
    });
    
    clearCachedDevice(deviceId);

    if (!deviceId || !userId) {
      return res
        .status(400)
        .json({ message: "Device ID and User ID are required" });
    }

    connection = await pool.getConnection();

    const [trackerExists] = await connection.query(
      "SELECT device_id FROM trackers WHERE device_id = ? AND user_id = ?",
      [deviceId, userId]
    );

    if (trackerExists.length === 0) {
      return res
        .status(404)
        .json({ message: "Tracker not found or doesn't belong to this user" });
    }

    await connection.query(
      "DELETE FROM geofence_assignment WHERE device_id = ? AND user_id = ?",
      [deviceId, userId]
    );

    const [deleteResult] = await connection.query(
      "DELETE FROM trackers WHERE device_id = ? AND user_id = ?",
      [deviceId, userId]
    );

    if (deleteResult.affectedRows > 0) {
      console.log(`✅ Deleted tracker ${deviceId} for user ${userId}`);
      return res.status(200).json({
        message: "Tracker deleted successfully",
        success: true,
      });
    } else {
      console.log(`⚠️ No tracker found to delete with ID ${deviceId}`);
      return res.status(404).json({
        message: "No tracker found to delete",
        success: false,
      });
    }
  } catch (err) {
    console.error("❌ Error deleting tracker:", err);
    console.error("Error stack:", err.stack);
    return res.status(500).json({
      message: "Failed to delete tracker",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// SAVE GEOFENCE
app.post("/api/geofences", async (req, res) => {
  let connection;
  try {
    const {
      user_id,
      device_ids,
      geofence_name,
      type,
      center_lat,
      center_lng,
      radius,
      poly_rect,
    } = req.body;

    console.log("📍 Geofence save request:", req.body);

    if (
      !user_id ||
      !Array.isArray(device_ids) ||
      device_ids.length === 0 ||
      !type
    ) {
      return res
        .status(400)
        .json({ message: "user_id, device_ids[], and type are required" });
    }

    if (
      type === "circle" &&
      (center_lat === undefined ||
        center_lng === undefined ||
        radius === undefined)
    ) {
      return res
        .status(400)
        .json({ message: "Missing center or radius for circle geofence" });
    }

    if ((type === "polygon" || type === "rectangle") && !poly_rect) {
      return res.status(400).json({
        message: "Missing coordinates for polygon/rectangle geofence",
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [geofenceResult] = await connection.query(
      `INSERT INTO geofences (geofence_name, type, center_lat, center_lng, radius, poly_rect, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        geofence_name || null,
        type,
        center_lat || null,
        center_lng || null,
        radius || null,
        poly_rect || null,
      ]
    );

    const geofence_id = geofenceResult.insertId;

    const assignmentInserts = device_ids.map((device_id) => [
      geofence_id,
      device_id,
      user_id,
      new Date(),
    ]);

    await connection.query(
      `INSERT INTO geofence_assignment (geofence_id, device_id, user_id, created_at)
       VALUES ?`,
      [assignmentInserts]
    );

    await connection.commit();

    console.log(
      `✅ Geofence ${geofence_id} saved and assigned to devices: ${device_ids.join(
        ", "
      )}`
    );
    return res.status(201).json({ message: "Geofence saved successfully" });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("❌ Geofence save error:", err.message);
    return res.status(500).json({ message: "Failed to save geofence" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("⚠️ Failed to release MySQL connection:", e.message);
    }
  }
});

// DELETE GEOFENCE
app.delete("/api/geofences/delete/:geofenceId", async (req, res) => {
  let connection;
  try {
    const { geofenceId } = req.params;
    const deviceIdsRaw = req.query.deviceIds;

    const deviceIds = Array.isArray(deviceIdsRaw)
      ? deviceIdsRaw
      : typeof deviceIdsRaw === "string"
      ? deviceIdsRaw.split(",").filter((d) => d.trim() !== "")
      : [];

    if (!geofenceId) {
      return res.status(400).json({ message: "Geofence ID is required" });
    }

    if (deviceIds.length === 0) {
      return res.status(400).json({ message: "Device IDs are required" });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [deleteResult] = await connection.query(
      `
      DELETE FROM geofence_assignment 
      WHERE geofence_id = ? AND device_id IN (?)
    `,
      [geofenceId, deviceIds]
    );

    if (deleteResult.affectedRows === 0) {
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "No matching geofence-device links found" });
    }

    const [remaining] = await connection.query(
      `SELECT COUNT(*) as count FROM geofence_assignment WHERE geofence_id = ?`,
      [geofenceId]
    );

    if (remaining[0].count === 0) {
      await connection.query(`DELETE FROM geofences WHERE geofence_id = ?`, [
        geofenceId,
      ]);
    }

    await connection.commit();
    return res.status(200).json({
      message: `Deleted ${deleteResult.affectedRows} device assignment(s)`,
    });
  } catch (err) {
    console.error("❌ Error deleting geofence:", err.message);
    if (connection) await connection.rollback();
    return res.status(500).json({ message: "Failed to delete geofence(s)" });
  } finally {
    if (connection) connection.release();
  }
});

// GET GEOFENCE FOR A USER
app.get("/api/geofences/:userId", async (req, res) => {
  let connection;
  try {
    const userId = req.params.userId;
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      SELECT
        g.geofence_id,
        g.geofence_name,
        g.type,
        g.center_lat,
        g.center_lng,
        g.radius,
        g.poly_rect,
        ga.device_id,
        t.pet_name
      FROM geofences g
      JOIN geofence_assignment ga ON g.geofence_id = ga.geofence_id
      LEFT JOIN trackers t ON ga.device_id = t.device_id
      WHERE ga.user_id = ?
      `,
      [userId]
    );

    const geofenceMap = {};

    for (const row of rows) {
      const geofenceId = row.geofence_id;

      const type = row.type?.toLowerCase();
      let isValid = false;

      if (type === "circle") {
        isValid =
          typeof row.center_lat === "number" &&
          typeof row.center_lng === "number" &&
          typeof row.radius === "number" &&
          !isNaN(row.center_lat) &&
          !isNaN(row.center_lng) &&
          !isNaN(row.radius);
      } else if (type === "polygon" || type === "rectangle") {
        try {
          const parsed = JSON.parse(row.poly_rect || "[]");
          isValid =
            Array.isArray(parsed) &&
            parsed.length >= 3 &&
            parsed.every(
              (pt) =>
                Array.isArray(pt) &&
                typeof pt[0] === "number" &&
                typeof pt[1] === "number" &&
                !isNaN(pt[0]) &&
                !isNaN(pt[1])
            );
        } catch {
          isValid = false;
        }
      }

      if (!isValid) {
        console.warn(`⚠️ Skipping invalid geofence_id ${geofenceId}`);
        continue;
      }

      if (!geofenceMap[geofenceId]) {
        geofenceMap[geofenceId] = {
          geofence_id: geofenceId,
          geofence_name: row.geofence_name,
          type: row.type,
          center_lat: row.center_lat,
          center_lng: row.center_lng,
          radius: row.radius,
          poly_rect: row.poly_rect,
          deviceIds: [],
          deviceNames: [],
        };
      }

      if (row.device_id?.trim()) {
        geofenceMap[geofenceId].deviceIds.push(row.device_id.trim());
        geofenceMap[geofenceId].deviceNames.push(
          row.pet_name?.trim() || "(Unnamed)"
        );
      }
    }

    return res.status(200).json(Object.values(geofenceMap));
  } catch (err) {
    console.error("❌ Error fetching geofences:", err.message);
    return res.status(500).json({ message: "Failed to fetch geofences" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("⚠️ Failed to release MySQL connection:", e.message);
    }
  }
});

// REGISTER
app.post("/api/register", async (req, res) => {
  let connection;
  try {
    console.log("📥 Incoming request:", req.body);

    const { firstName, lastName, phone, username, email, password } = req.body;

    if (!firstName || !lastName || !phone || !username || !email || !password) {
      console.log("Missing fields");
      return res.status(400).json({ message: "All fields are required" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    console.log("🔐 Password hashed");

    connection = await pool.getConnection();
    console.log("🔗 MySQL connection acquired");

    const [results] = await connection.query(
      "SELECT email, phone, username FROM users WHERE email = ? OR phone = ? OR username = ?",
      [email, phone, username]
    );

    let emailExists = false;
    let phoneExists = false;
    let usernameExists = false;

    results.forEach((user) => {
      if (user.email === email) emailExists = true;
      if (user.phone === phone) phoneExists = true;
      if (user.username === username) usernameExists = true;
    });

    if (emailExists || phoneExists || usernameExists) {
      console.log("⚠️ Conflict - Already exists:", {
        emailExists,
        phoneExists,
        usernameExists,
      });
      return res.status(409).json({ emailExists, phoneExists, usernameExists });
    }

    await connection.query(
      "INSERT INTO users (first_name, last_name, phone, username, email, password) VALUES (?, ?, ?, ?, ?, ?)",
      [firstName, lastName, phone, username, email, hashedPassword]
    );

    console.log("User inserted");
    return res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error("Registration Error:", err.message, err.stack);
    return res.status(500).json({ message: "Server error" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("Failed to release MySQL connection:", e.message);
    }
  }
});

// SEND EMAIL VERIFICATION
app.post("/api/send-verification-code", async (req, res) => {
  let connection;
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000)).padStart(
      6,
      "0"
    );

    connection = await pool.getConnection();

    const [users] = await connection.query(
      "SELECT user_id FROM users WHERE email = ?",
      [email]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = users[0].user_id;

    await connection.query("DELETE FROM verification_codes WHERE user_id = ?", [
      userId,
    ]);

    await connection.query(
      "INSERT INTO verification_codes (user_id, email, code, created_at) VALUES (?, ?, ?, NOW())",
      [userId, email, code]
    );

    console.log(`📧 Verification code sent for ${email}`);

    await transporter.sendMail({
      from: `"Pet Tracker" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "🔒 Verify Your Email – Pet Tracker",
      html: `
        <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 20px;">
          <div style="max-width: 480px; margin: auto; background: #ffffff; border-radius: 8px; padding: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);">
            <h2 style="margin-top: 0; color: #5c4033;">Pet Tracker Email Verification</h2>
            <p style="font-size: 14px; color: #333;">Your 6-digit verification code is:</p>
            <div style="text-align: center; margin: 20px 0;">
              <span style="display: inline-block; font-size: 28px; font-weight: bold; color: #333; letter-spacing: 8px; background: #f3f3f3; padding: 12px 20px; border-radius: 6px;">
                ${code}
              </span>
            </div>
            <p style="font-size: 13px; color: #666; text-align: center;">This code is valid until you request a new one.</p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
            <p style="font-size: 12px; color: #999; text-align: center;">If you didn't request this, you can ignore this email.</p>
          </div>
        </div>
      `,
    });

    console.log("Verification code sent to", email);
    return res.status(200).json({ message: "Verification code sent" });
  } catch (err) {
    console.error("Error sending verification code:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to send verification code" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("Failed to release MySQL connection:", e.message);
    }
  }
});

// VERIFY CODE
app.post("/api/verify-code", async (req, res) => {
  let connection;
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      console.warn("Missing email or code:", { email, code });
      return res.status(400).json({ message: "Email and code are required" });
    }

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      "SELECT user_id, created_at FROM verification_codes WHERE email = ? AND code = ?",
      [email, code]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: "Invalid code" });
    }

    const { user_id } = rows[0];

    await connection.query(
      "UPDATE users SET email_verification = 1 WHERE user_id = ? AND email = ?",
      [user_id, email]
    );

    await connection.query("DELETE FROM verification_codes WHERE user_id = ?", [
      user_id,
    ]);

    console.log(`Verified user_id ${user_id} (${email})`);
    return res.status(200).json({ message: "Email verified" });
  } catch (err) {
    console.error("Verification error:", err.message);
    return res.status(500).json({ message: "Failed to verify email" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("Failed to release MySQL connection:", e.message);
    }
  }
});

// SEND SMS VERIFICATION CODE
app.post("/api/send-sms-verification-code", async (req, res) => {
  let connection;
  try {
    console.log("📞 SMS verification request received:", {
      body: req.body,
      headers: req.headers["content-type"],
      url: req.url,
      method: req.method,
    });

    const { phone, userId } = req.body;

    if (!phone || !userId) {
      console.log("❌ Missing required fields:", {
        phone: !!phone,
        userId: !!userId,
      });
      return res.status(400).json({
        message: "Phone number and user ID are required",
      });
    }

    connection = await pool.getConnection();

    const [users] = await connection.query(
      "SELECT user_id FROM users WHERE user_id = ?",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const customCode = generateOTPCode(6);
    console.log(`🔢 Generated OTP code: ${customCode} for user ${userId}`);

    let formattedPhone = phone;
    if (formattedPhone.startsWith("63")) {
      formattedPhone = phone;
    } else if (formattedPhone.startsWith("09")) {
      formattedPhone = "63" + phone.substring(1);
    } else if (formattedPhone.startsWith("9")) {
      formattedPhone = "63" + phone;
    }

    console.log(`📱 Formatted phone: ${phone} -> ${formattedPhone}`);

    await connection.query(
      "DELETE FROM sms_verification_codes WHERE user_id = ?",
      [userId]
    );

    await connection.query(
      "INSERT INTO sms_verification_codes (user_id, phone, code, created_at) VALUES (?, ?, ?, NOW())",
      [userId, formattedPhone, customCode]
    );

    const message = "Your Pet Tracker verification code is: {otp}.";
    console.log(
      `📱 Sending SMS to ${formattedPhone} with message: "${message}" and customCode: ${customCode}`
    );
    const result = await sendOTPSMS(formattedPhone, message, customCode);

    if (result.success) {
      console.log(
        `📱 SMS verification code sent to ${formattedPhone} for user ${userId}`
      );
      return res.status(200).json({
        message: "SMS verification code sent successfully",
        otpCode: customCode,
        messageId: result.messageId,
      });
    } else {
      await connection.query(
        "DELETE FROM sms_verification_codes WHERE user_id = ? AND code = ?",
        [userId, customCode]
      );

      return res.status(500).json({
        message: "Failed to send SMS verification code",
        error: result.error,
      });
    }
  } catch (err) {
    console.error("❌ Error sending SMS verification code:", err.message);
    return res.status(500).json({
      message: "Server error while sending SMS verification code",
    });
  } finally {
    if (connection) connection.release();
  }
});

// VERIFY SMS CODE
app.post("/api/verify-sms-code", async (req, res) => {
  let connection;
  try {
    const { userId, phone, code } = req.body;

    if (!userId || !phone || !code) {
      return res.status(400).json({
        message: "User ID, phone number, and code are required",
      });
    }

    if (!validateOTPCode(code, 6)) {
      return res.status(400).json({
        message: "Invalid code format. Code must be 6 digits.",
      });
    }

    connection = await pool.getConnection();

    console.log(`🔍 SMS Verification Debug:`, {
      originalPhone: phone,
      userId: userId,
      code: code,
    });

    let [rows] = await connection.query(
      "SELECT sms_verification_id, created_at FROM sms_verification_codes WHERE user_id = ? AND phone = ? AND code = ?",
      [userId, phone, code]
    );

    if (rows.length === 0) {
      let formattedPhone = phone;
      if (!formattedPhone.startsWith("63")) {
        if (formattedPhone.startsWith("09")) {
          formattedPhone = "63" + phone.substring(1);
        } else if (formattedPhone.startsWith("9")) {
          formattedPhone = "63" + phone;
        } else {
          formattedPhone = "63" + phone;
        }
      }

      [rows] = await connection.query(
        "SELECT sms_verification_id, created_at FROM sms_verification_codes WHERE user_id = ? AND phone = ? AND code = ?",
        [userId, formattedPhone, code]
      );

      console.log(`🔍 Tried formatted phone:`, {
        formattedPhone: formattedPhone,
        rowsFound: rows.length,
      });
    }

    console.log(`🔍 Database query result:`, {
      rowsFound: rows.length,
      searchCriteria: { userId, phone, code },
    });

    const [allCodes] = await connection.query(
      "SELECT phone, code FROM sms_verification_codes WHERE user_id = ?",
      [userId]
    );
    console.log(`🔍 All codes for user ${userId}:`, allCodes);

    if (rows.length === 0) {
      return res.status(400).json({
        message: "Invalid or expired verification code",
      });
    }

    await connection.query(
      "UPDATE users SET phone_verification = 1, phone = ? WHERE user_id = ?",
      [phone, userId]
    );

    await connection.query(
      "DELETE FROM sms_verification_codes WHERE user_id = ?",
      [userId]
    );

    console.log(`✅ SMS verified for user ${userId} with phone ${phone}`);
    return res.status(200).json({
      message: "Phone number verified successfully",
    });
  } catch (err) {
    console.error("❌ Error verifying SMS code:", err.message);
    return res.status(500).json({
      message: "Server error while verifying SMS code",
    });
  } finally {
    if (connection) connection.release();
  }
});

// UPDATE PASSWORD
app.post("/api/update-password", async (req, res) => {
  let connection;
  try {
    const { userId, currentPassword, newPassword } = req.body;

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      "SELECT password FROM users WHERE user_id = ?",
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);

    if (!isMatch) {
      return res.status(401).json({ message: "Incorrect current password" });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    await connection.query("UPDATE users SET password = ? WHERE user_id = ?", [
      hashedNewPassword,
      userId,
    ]);

    return res.status(200).json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Password update error:", err.message);
    return res.status(500).json({ message: "Failed to update password" });
  } finally {
    if (connection) connection.release();
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  let connection;
  try {
    const { identifier, password } = req.body;
    console.log("Login request:", { identifier });

    if (!identifier || !password) {
      return res
        .status(400)
        .json({ message: "Username/Email and password required" });
    }

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      "SELECT user_id, first_name, last_name, email, phone, username, password, account_type FROM users WHERE email = ? OR username = ?",
      [identifier, identifier]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account not found" });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const token = jwt.sign(
      {
        userId: user.user_id,
        email: user.email,
        username: user.username,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      token,
      user: {
        userId: user.user_id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone || "",
        username: user.username,
        account_type: user.account_type || null,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("Failed to release MySQL connection:", e.message);
    }
  }
});

// GET USER PROFILE
app.post("/api/user-profile", async (req, res) => {
  let connection;
  try {
    const { email, username } = req.body;

    if (!email && !username) {
      return res.status(400).json({ message: "Email or username is required" });
    }

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      "SELECT user_id, first_name, last_name, phone, email, username, email_verification, phone_verification, profile_photo FROM users WHERE email = ? OR username = ?",
      [email || "", username || ""]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];
    if (user.profile_photo) {
      user.profile_photo = user.profile_photo.toString("base64");
    }

    return res.status(200).json({ user });
  } catch (err) {
    console.error("User profile fetch error:", err.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("Failed to release MySQL connection:", e.message);
    }
  }
});

// UPDATE USER PROFILE
app.put("/api/user-profile", async (req, res) => {
  let connection;
  try {
    const {
      user_id,
      first_name,
      last_name,
      phone,
      email,
      username,
      profile_photo,
    } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "User ID is required" });
    }

    connection = await pool.getConnection();

    // Check if user exists
    const [existingUser] = await connection.query(
      "SELECT user_id FROM users WHERE user_id = ?",
      [user_id]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check for duplicate email or username (excluding current user)
    if (email || username) {
      const [duplicates] = await connection.query(
        "SELECT email, username FROM users WHERE (email = ? OR username = ?) AND user_id != ?",
        [email || "", username || "", user_id]
      );

      if (duplicates.length > 0) {
        const duplicate = duplicates[0];
        let message = "";
        if (duplicate.email === email) message = "Email already exists";
        if (duplicate.username === username)
          message = "Username already exists";
        return res.status(409).json({ message });
      }
    }

    // Prepare update query
    let updateFields = [];
    let updateValues = [];

    if (first_name !== undefined) {
      updateFields.push("first_name = ?");
      updateValues.push(first_name);
    }
    if (last_name !== undefined) {
      updateFields.push("last_name = ?");
      updateValues.push(last_name);
    }
    if (phone !== undefined) {
      updateFields.push("phone = ?");
      updateValues.push(phone);
    }
    if (email !== undefined) {
      updateFields.push("email = ?");
      updateValues.push(email);
    }
    if (username !== undefined) {
      updateFields.push("username = ?");
      updateValues.push(username);
    }
    if (profile_photo !== undefined) {
      updateFields.push("profile_photo = ?");
      if (profile_photo && typeof profile_photo === "string") {
        const base64Data = profile_photo.replace(
          /^data:image\/[a-z]+;base64,/,
          ""
        );
        updateValues.push(Buffer.from(base64Data, "base64"));
      } else {
        updateValues.push(null);
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    updateValues.push(user_id);

    const updateQuery = `UPDATE users SET ${updateFields.join(
      ", "
    )} WHERE user_id = ?`;

    const [result] = await connection.query(updateQuery, updateValues);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // Fetch updated user data
    const [updatedUser] = await connection.query(
      "SELECT user_id, first_name, last_name, phone, email, username, email_verification, phone_verification, profile_photo FROM users WHERE user_id = ?",
      [user_id]
    );

    const user = updatedUser[0];
    if (user.profile_photo) {
      user.profile_photo = user.profile_photo.toString("base64");
    }

    return res.status(200).json({
      message: "Profile updated successfully",
      user,
    });
  } catch (err) {
    console.error("User profile update error:", err.message);
    return res.status(500).json({ message: "Server error" });
  } finally {
    try {
      if (connection) connection.release();
    } catch (e) {
      console.warn("Failed to release MySQL connection:", e.message);
    }
  }
});

// GET ALL NOTIFICATIONS
app.get("/api/notifications", async (req, res) => {
  let connection;
  try {
    const userId = req.query.userId;

    connection = await pool.getConnection();

    let query = `SELECT notification_id as id, user_id, device_id, message, created_at, is_read 
                FROM notifications`;

    const params = [];
    if (userId) {
      query += ` WHERE user_id = ?`;
      params.push(userId);
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

    const [notifications] = await connection.query(query, params);

    return res.status(200).json(notifications);
  } catch (err) {
    console.error("❌ Error fetching notifications:", err.message);
    return res.status(500).json({ message: "Failed to fetch notifications" });
  } finally {
    if (connection) connection.release();
  }
});

// MARK NOTIFICATION AS READ
app.put("/api/notifications/:notificationId/read", async (req, res) => {
  let connection;
  try {
    const { notificationId } = req.params;

    connection = await pool.getConnection();

    await connection.query(
      `UPDATE notifications SET is_read = 1 WHERE notification_id = ?`,
      [notificationId]
    );

    return res.status(200).json({ message: "Notification marked as read" });
  } catch (err) {
    console.error("❌ Error marking notification as read:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to mark notification as read" });
  } finally {
    if (connection) connection.release();
  }
});

// MARK ALL NOTIFICATIONS AS READ
app.put("/api/notifications/mark-all-read", async (req, res) => {
  let connection;
  try {
    const userId = req.query.userId;

    connection = await pool.getConnection();

    let query = `UPDATE notifications SET is_read = 1`;
    const params = [];

    if (userId) {
      query += ` WHERE user_id = ?`;
      params.push(userId);
    }

    await connection.query(query, params);

    return res
      .status(200)
      .json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("❌ Error marking all notifications as read:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to mark all notifications as read" });
  } finally {
    if (connection) connection.release();
  }
});

// CLEAR ALL NOTIFICATIONS
app.delete("/api/notifications/clear-all", async (req, res) => {
  let connection;
  try {
    const userId = req.query.userId;

    connection = await pool.getConnection();

    let query = `DELETE FROM notifications`;
    const params = [];

    if (userId) {
      query += ` WHERE user_id = ?`;
      params.push(userId);
    }

    await connection.query(query, params);

    return res.status(200).json({ message: "All notifications cleared" });
  } catch (err) {
    console.error("❌ Error clearing notifications:", err.message);
    return res.status(500).json({ message: "Failed to clear notifications" });
  } finally {
    if (connection) connection.release();
  }
});

// CREATE SMS NOTIFICATION SETTINGS FOR A USER
app.post("/api/sms-notification-settings/:userId", async (req, res) => {
  let connection;
  try {
    const { userId } = req.params;
    const {
      enable_sms_notification,
      online,
      offline,
      out_geofence,
      in_geofence,
      low_battery,
      nearby_pet,
      meter_radius,
    } = req.body;

    connection = await pool.getConnection();

    const [existing] = await connection.query(
      `SELECT sms_setting_id FROM sms_notification_settings WHERE user_id = ?`,
      [userId]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: "SMS notification settings already exist for this user",
      });
    }

    await connection.query(
      `INSERT INTO sms_notification_settings (user_id, enable_sms_notification, online, offline, out_geofence, in_geofence, low_battery, nearby_pet, meter_radius)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        enable_sms_notification,
        online,
        offline,
        out_geofence,
        in_geofence,
        low_battery,
        nearby_pet,
        meter_radius,
      ]
    );

    res
      .status(201)
      .json({ message: "SMS notification settings created successfully" });
  } catch (err) {
    console.error("❌ Error creating SMS notification settings:", err.message);
    res
      .status(500)
      .json({ message: "Failed to create SMS notification settings" });
  } finally {
    if (connection) connection.release();
  }
});

// GET SMS NOTIFICATION SETTINGS FOR A USER
app.get("/api/sms-notification-settings/:userId", async (req, res) => {
  let connection;
  try {
    const { userId } = req.params;

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT sms_setting_id, enable_sms_notification, online, offline, out_geofence, in_geofence, low_battery, nearby_pet, meter_radius
       FROM sms_notification_settings
       WHERE user_id = ?`,
      [userId]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error("❌ Error fetching SMS notification settings:", err.message);
    res
      .status(500)
      .json({ message: "Failed to fetch SMS notification settings" });
  } finally {
    if (connection) connection.release();
  }
});

// UPDATE SMS NOTIFICATION SETTINGS FOR A USER
app.put("/api/sms-notification-settings/:userId", async (req, res) => {
  let connection;
  try {
    const { userId } = req.params;
    const {
      enable_sms_notification,
      online,
      offline,
      out_geofence,
      in_geofence,
      low_battery,
      nearby_pet,
      meter_radius,
    } = req.body;

    connection = await pool.getConnection();

    await connection.query(
      `UPDATE sms_notification_settings
       SET enable_sms_notification = ?, online = ?, offline = ?, out_geofence = ?, in_geofence = ?, low_battery = ?, nearby_pet = ?, meter_radius = ?
       WHERE user_id = ?`,
      [
        enable_sms_notification,
        online,
        offline,
        out_geofence,
        in_geofence,
        low_battery,
        nearby_pet,
        meter_radius,
        userId,
      ]
    );

    res
      .status(200)
      .json({ message: "SMS notification settings updated successfully" });
  } catch (err) {
    console.error("❌ Error updating SMS notification settings:", err.message);
    res
      .status(500)
      .json({ message: "Failed to update SMS notification settings" });
  } finally {
    if (connection) connection.release();
  }
});

// ROOT
app.get("/", (req, res) => {
  res.send("📡 HTTP + Socket.IO Pet Tracker running");
});

// SERVER START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 HTTP + Socket.IO server running on port ${PORT}`);
});
