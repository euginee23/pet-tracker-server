/**
 * Database connection retry utility
 * Provides helper functions for executing database operations with retry logic
 */

/**
 * Execute a database operation with retry logic
 * @param {Function} operation - Async function that performs the database operation
 * @param {Object} pool - MySQL connection pool
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} initialDelay - Initial delay between retries in ms (default: 500)
 * @returns {Promise<*>} - Result of the database operation
 */
async function executeWithRetry(operation, pool, maxRetries = 3, initialDelay = 500) {
  let lastError;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let connection;
    
    try {
      // Get a connection from the pool
      connection = await pool.getConnection();
      
      // Execute the operation
      const result = await operation(connection);
      
      // If successful, return the result
      return result;
    } catch (error) {
      lastError = error;
      
      // Check if this is a connection error that we should retry
      const isRetryableError = 
        error.code === 'ECONNRESET' || 
        error.code === 'PROTOCOL_CONNECTION_LOST' ||
        error.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
        error.code === 'ETIMEDOUT';
      
      // Log the error
      console.error(`Database operation failed (attempt ${attempt + 1}/${maxRetries + 1}):`, {
        errorCode: error.code,
        errorMessage: error.message,
        retrying: attempt < maxRetries && isRetryableError
      });
      
      // If we've reached max retries or it's not a retryable error, throw the error
      if (attempt >= maxRetries || !isRetryableError) {
        throw error;
      }
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Double the delay for each retry
    } finally {
      // Always release the connection if we got one
      if (connection) {
        try {
          connection.release();
        } catch (releaseError) {
          console.warn('Error releasing connection:', releaseError.message);
        }
      }
    }
  }
  
  // This should not be reached due to the throw in the loop, but just in case
  throw lastError;
}

/**
 * Execute a simple query with retry logic
 * @param {Object} pool - MySQL connection pool
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} - Query results
 */
async function queryWithRetry(pool, sql, params = []) {
  return executeWithRetry(async (connection) => {
    const [result] = await connection.query(sql, params);
    return result;
  }, pool);
}

module.exports = {
  executeWithRetry,
  queryWithRetry
};
