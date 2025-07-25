const axios = require('axios');

async function sendSMS({ number, message }) {
  const apiKey = process.env.SEMAPHORE_API_KEY;
  if (!apiKey) throw new Error('Semaphore API key not set');
  const url = 'https://api.semaphore.co/api/v4/messages';

  console.log('📱 Sending SMS to:', number);
  console.log('📝 Message content:', message);
  console.log('🔑 Using API key:', apiKey.substring(0, 5) + '...');

  try {
    // Note: According to Semaphore API docs, message should not start with "TEST"
    if (message.trim().toUpperCase().startsWith('TEST')) {
      console.warn('⚠️ Message starts with "TEST" which might be ignored by Semaphore API');
    }

    const payload = {
      apikey: apiKey,
      number,
      message,
      sendername: 'SEMAPHORE' // Default sender name, can be customized
    };
    
    console.log('📤 Sending SMS payload:', JSON.stringify(payload));
    
    const response = await axios.post(url, payload);
    console.log('📥 SMS API response:', JSON.stringify(response.data));
    
    // Check for rate limiting headers
    if (response.headers['x-ratelimit-remaining']) {
      console.log(`ℹ️ Rate limit remaining: ${response.headers['x-ratelimit-remaining']}/${response.headers['x-ratelimit-limit']}`);
    }
    
    return response.data;
  } catch (err) {
    console.error('❌ Semaphore SMS error:', err.response?.data || err.message);
    if (err.response) {
      console.error('Error status:', err.response.status);
      console.error('Error headers:', JSON.stringify(err.response.headers));
      console.error('Error data:', JSON.stringify(err.response.data));
    }
    throw err;
  }
}

module.exports = { sendSMS };
