const axios = require("axios");

async function sendSMS(phoneNumber, message, senderName = process.env.SMS_SENDER_NAME) {
  try {
    const response = await axios.post(
      "https://api.semaphore.co/api/v4/messages",
      {
        apikey: process.env.SMS_API_TOKEN,
        number: phoneNumber,
        message: message,
        sendername: senderName
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Semaphore API response:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending SMS via Semaphore API:", error.response?.data || error.message);
    throw error;
  }
}

module.exports = { sendSMS };
