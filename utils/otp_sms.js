const axios = require('axios');

/**
 * Send OTP SMS using Semaphore API
 * @param {string} phoneNumber - The recipient's phone number
 * @param {string} message - The message template with {otp} placeholder
 * @param {string} customCode - Optional custom OTP code (if not provided, auto-generated)
 * @returns {Promise<Object>} - Response from Semaphore API
 */
async function sendOTPSMS(phoneNumber, message, customCode = null) {
  try {
    const payload = {
      apikey: process.env.SMS_API_TOKEN,
      number: phoneNumber,
      message: message
    };

    // Add custom code if provided
    if (customCode) {
      payload.code = customCode;
    }

    const response = await axios.post('https://api.semaphore.co/api/v4/otp', payload);
    
    console.log('✅ OTP SMS sent successfully:', response.data);
    return {
      success: true,
      data: response.data,
      otpCode: response.data[0]?.code,
      messageId: response.data[0]?.message_id
    };
  } catch (error) {
    console.error('❌ Failed to send OTP SMS:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

/**
 * Generate a random OTP code
 * @param {number} length - Length of the OTP code (default: 6)
 * @returns {string} - Generated OTP code
 */
function generateOTPCode(length = 6) {
  const digits = '0123456789';
  let otp = '';
  
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  
  return otp;
}

/**
 * Validate OTP code format
 * @param {string} code - OTP code to validate
 * @param {number} expectedLength - Expected length of the OTP code (default: 6)
 * @returns {boolean} - True if valid, false otherwise
 */
function validateOTPCode(code, expectedLength = 6) {
  if (!code || typeof code !== 'string') {
    return false;
  }
  
  // Check if code is numeric and has correct length
  const isNumeric = /^\d+$/.test(code);
  const hasCorrectLength = code.length === expectedLength;
  
  return isNumeric && hasCorrectLength;
}

module.exports = {
  sendOTPSMS,
  generateOTPCode,
  validateOTPCode
};
