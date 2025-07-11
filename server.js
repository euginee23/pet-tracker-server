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

const CHECK_INTERVAL = 10000;
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

function broadcastDevices() {
  const allDevices = getAllDevicesWithStatus();
  io.emit("devices", allDevices);
}

// SOCKET CONNECTION
io.on("connection", (socket) => {
  console.log("🔌 Client connected via Socket.IO");
  socket.emit("devices", getAllDevicesWithStatus());

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
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

    latestDevices[data.deviceId] = {
      lat: data.lat,
      lng: data.lng,
      battery: data.battery,
      lastSeen: now,
      online: true,
    };

    if (deviceStatus[data.deviceId] !== "online") {
      console.log(`🟢 ${data.deviceId} is now ONLINE`);
      deviceStatus[data.deviceId] = "online";
    }

    connection = await pool.getConnection();
    const [geofences] = await connection.query(
      "SELECT * FROM geofences WHERE device_id = ?",
      [data.deviceId]
    );

    if (geofences.length === 0) {
      console.log(
        `ℹ️ No geofences set for ${data.deviceId}. Skipping geofence check.`
      );
    } else {
      const result = isInsideGeofence(data.lat, data.lng, geofences);
      if (!result.isInside) {
        console.warn(
          `⚠️ Pet ${data.deviceId} is OUTSIDE all geofences! (~${result.distance}m away)`
        );
      } else {
        console.log(`✅ Pet ${data.deviceId} is INSIDE a geofence.`);
      }
    }

    console.log("📥 Received from device:", data);
    broadcastDevices();
    res.status(200).send("✅ Data received");
  } catch (err) {
    console.error("❌ Error handling /data:", err);
    res.status(500).send("Server error");
  } finally {
    if (connection) connection.release();
  }
});

// OFFLINE CHECK
setInterval(() => {
  const now = Date.now();

  for (const [deviceId, info] of Object.entries(latestDevices)) {
    const isOffline = now - info.lastSeen > CHECK_INTERVAL;
    if (isOffline && deviceStatus[deviceId] !== "offline") {
      console.log(`🔴 ${deviceId} is now OFFLINE`);
      deviceStatus[deviceId] = "offline";
    }
  }

  broadcastDevices();
}, 5000);

// SIMULATION LOGIC
let simulationIntervals = {};
let simulatedDevices = {};

function startSimulation(deviceId, batteryOverride = null) {
  if (simulationIntervals[deviceId]) return;

  const angle = Math.random() * 2 * Math.PI;
  simulatedDevices[deviceId] = {
    angle,
    position: {
      lat: 8.090881 + Math.random() * 0.002,
      lng: 123.488679 + Math.random() * 0.002,
    },
  };

  simulationIntervals[deviceId] = setInterval(async () => {
    const device = simulatedDevices[deviceId];
    device.angle += (Math.random() - 0.5) * 0.4;

    const speed = 0.000015;
    const dx = Math.cos(device.angle) * speed;
    const dy = Math.sin(device.angle) * speed;

    device.position.lat += dy;
    device.position.lng += dx;

    const batteryLevel = batteryOverride ?? Math.floor(50 + Math.random() * 50);

    const payload = {
      deviceId,
      lat: device.position.lat,
      lng: device.position.lng,
      battery: batteryLevel,
    };

    try {
      await axios.post("http://192.168.254.101:3000/data", payload);
      console.log(`🧪 Sent simulated data for ${deviceId}:`, payload);
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

// SAVE GEOFENCE
app.post("/api/geofences", async (req, res) => {
  let connection;
  try {
    const {
      user_id,
      device_id,
      type,
      center_lat,
      center_lng,
      radius,
      poly_rect,
    } = req.body;

    console.log("📍 Geofence save request:", req.body);

    if (!user_id || !device_id || !type) {
      return res
        .status(400)
        .json({ message: "user_id, device_id, and type are required" });
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

    if (type === "polygon" && !poly_rect) {
      return res
        .status(400)
        .json({ message: "Missing polygon coordinates for polygon geofence" });
    }

    connection = await pool.getConnection();

    await connection.query(
      `
      INSERT INTO geofences 
        (user_id, device_id, type, center_lat, center_lng, radius, poly_rect, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `,
      [
        user_id,
        device_id,
        type,
        center_lat || null,
        center_lng || null,
        radius || null,
        poly_rect || null,
      ]
    );

    console.log(`✅ Geofence saved for ${device_id} (${type})`);
    return res.status(201).json({ message: "Geofence saved successfully" });
  } catch (err) {
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

// GET ALL GEOFENCES FOR USER
app.get("/api/geofences/:userId", async (req, res) => {
  let connection;
  try {
    const userId = req.params.userId;

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      "SELECT * FROM geofences WHERE user_id = ?",
      [userId]
    );

    return res.status(200).json(rows);
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
            <p style="font-size: 13px; color: #666; text-align: center;">This code is valid for 10 minutes.</p>
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

    const { user_id, created_at } = rows[0];
    const expiryTime = new Date(created_at).getTime() + 10 * 60 * 1000;

    if (Date.now() > expiryTime) {
      return res.status(400).json({ message: "Verification code expired" });
    }

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
      "SELECT user_id, first_name, last_name, email, phone, username, password FROM users WHERE email = ? OR username = ?",
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
      "SELECT user_id, first_name, last_name, phone, email, username, email_verification, phone_verification FROM users WHERE email = ? OR username = ?",
      [email || "", username || ""]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ user: rows[0] });
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

// ROOT
app.get("/", (req, res) => {
  res.send("📡 HTTP + Socket.IO Pet Tracker running");
});

// SERVER START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 HTTP + Socket.IO server running on port ${PORT}`);
});
