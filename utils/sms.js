const axios = require('axios');

async function sendSMS({ number, message }) {
  const apiKey = process.env.SEMAPHORE_API_KEY;
  if (!apiKey) throw new Error('Semaphore API key not set');
  const url = 'https://api.semaphore.co/api/v4/messages';

  try {
    const response = await axios.post(url, {
      apikey: apiKey,
      number,
      message,
      sendername: 'PetTracker'
    });
    return response.data;
  } catch (err) {
    console.error('Semaphore SMS error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendSMS };
