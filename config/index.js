require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  apiKey: process.env.API_KEY,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  modelName: process.env.MODEL_NAME || 'gemini-2.5-flash-lite-preview-09-2025',
  tutorialSessionTTL: 60 * 60 * 3, // 3 hours in seconds
};

