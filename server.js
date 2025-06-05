const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

app.get("/", (req, res) => {
  res.send("📡 WebSocket server running");
});

// Handle WebSocket connections
wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`🟢 WebSocket connection from ${ip}`);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      console.log("📥 From ESP:", data);

      // Broadcast to other clients
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    } catch (e) {
      console.log("❌ Invalid JSON:", message);
    }
  });

  ws.on("close", () => {
    console.log(`🔴 Disconnected: ${ip}`);
  });
});

const PORT = process.env.PORT || 443;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});
