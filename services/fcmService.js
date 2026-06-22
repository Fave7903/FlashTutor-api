// services/fcmService.js
const { admin, db } = require('../config/firestore');

class FCMService {
  /**
   * Pushes notifications to an array of User IDs, respecting their individual settings.
   * @param {string[]} userIds 
   * @param {string} title 
   * @param {string} body 
   * @param {Object} dataPayload - MUST be a flat map of string values only
   * @param {string} preferenceKey - 'arenaAlerts', 'chatMessages', or 'prizeAlerts'
   */
  async sendTargetedAlert(userIds, title, body, dataPayload = {}, preferenceKey) {
    if (!userIds || !userIds.length) return;

    let tokens = [];

    // Firestore db.getAll() supports a maximum of 100 document references per call.
    const chunkSize = 100;
    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);
      const refs = chunk.map(id => db.collection('users').doc(id));
      
      const snapshots = await db.getAll(...refs);
      
      snapshots.forEach(snap => {
        if (snap.exists) {
          const userData = snap.data();
          
          // Default to true if notificationSettings is missing or preference isn't explicitly set to false
          const settings = userData.notificationSettings || {};
          const wantsAlert = settings[preferenceKey] !== false; 
          
          if (wantsAlert && Array.isArray(userData.fcmTokens) && userData.fcmTokens.length > 0) {
            tokens.push(...userData.fcmTokens);
          }
        }
      });
    }

    // Deduplicate and filter any null/empty strings
    tokens = [...new Set(tokens.filter(t => t))];
    if (tokens.length === 0) return;

    // FCM requires all data values to be strings
    const stringifiedData = {};
    for (const [key, value] of Object.entries(dataPayload)) {
      stringifiedData[key] = String(value);
    }

    // Inside fcmService.js, update the message object:
    const message = {
        notification: { title, body },
        data: stringifiedData,
        tokens: tokens,
        // ⚡ ANDROID FIX: Force High Priority and Sound to trigger the Banner
        android: {
          priority: 'high', 
          notification: {
            tag: dataPayload.challengeId || 'general',
            sound: 'default', // Android requires a sound to trigger the pop-up
          }
        },
        // ⚡ iOS FIX: Force High Priority and Sound
        apns: {
          headers: {
            "apns-priority": "10", // 10 is max priority for Apple
            "apns-collapse-id": dataPayload.challengeId || 'general',
          },
          payload: {
            aps: {
              "thread-id": dataPayload.challengeId || 'general',
              sound: 'default', // iOS requires a sound to trigger the banner
            }
          }
        }
      };

    try {
      // Handles up to 500 tokens natively per call
      const response = await admin.messaging().sendEachForMulticast(message);
      
      // Cleanup: Optional logic here to remove unregistered tokens from Firestore 
      // based on response.responses[i].error.code === 'messaging/registration-token-not-registered'
      
      return response;
    } catch (error) {
      console.error('[FCMService] Broadcast Error:', error);
    }
  }
}

module.exports = new FCMService();