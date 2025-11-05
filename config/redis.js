const redis = require('redis');
const config = require('./index');

let client = null;

async function getRedisClient() {
  if (!client) {
    client = redis.createClient({
      url: config.redisUrl,
      socket: {
        tls: true,
        rejectUnauthorized: false,
        keepAlive: 10000, // keeps connection alive       
      reconnectStrategy: (retries) => {
        if (retries > 10) return new Error('Retry limit reached');
        return Math.min(retries * 50, 500); // retry delay
      },
    },
    });
    
    client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
    
    await client.connect();
    console.log('Redis client connected');
  }
  return client;
}

module.exports = { getRedisClient };

