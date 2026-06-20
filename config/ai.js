// const { GoogleGenerativeAI } = require("@google/generative-ai");
// const config = require('./index');

// const genAI = new GoogleGenerativeAI(config.apiKey);
// const model = genAI.getGenerativeModel({ model: config.modelName });

// module.exports = { model, genAI };

// config/ai.js
const { GoogleGenAI } = require('@google/genai');
const config = require('./index');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Guaranteed Authentication Injection
// We intercept Azure's environment variables and write them to a secure, 
// temporary file in the server's ephemeral storage that the SDK automatically reads.
if (process.env.GCP_CLIENT_EMAIL && process.env.GCP_PRIVATE_KEY) {
  const tempKeyPath = path.join(os.tmpdir(), 'vertex-key.json');
  fs.writeFileSync(tempKeyPath, JSON.stringify({
    client_email: process.env.GCP_CLIENT_EMAIL,
    private_key: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'),
    project_id: process.env.GOOGLE_CLOUD_PROJECT_ID || config.projectId
  }));
  
  // Tell the Google Auth Library exactly where to find the ADC file
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tempKeyPath;
}

// 2. Initialize the Modern Gen AI SDK
const ai = new GoogleGenAI({
  vertexai: true, // Notice this is now a boolean!
  project: process.env.GOOGLE_CLOUD_PROJECT_ID,
  location: 'global'
});

// 3. The Compatibility Adapter
// Wraps the new SDK methods to match your existing app architecture.
const model = {
  generateContent: async (request) => {
    const contents = typeof request === 'string' ? request : request.contents;
    const genConfig = typeof request === 'object' ? request.generationConfig : {};
    
    const response = await ai.models.generateContent({
      model: config.modelName,
      contents: contents,
      config: genConfig
    });

    return {
      response: {
        text: () => response.text, 
        candidates: [{ 
          content: { parts: [{ text: response.text }] } 
        }] 
      }
    };
  },

  startChat: (chatOptions) => {
    const chat = ai.chats.create({
      model: config.modelName,
      history: chatOptions?.history || []
    });

    return {
      sendMessage: async (message) => {
        // The new SDK expects { message: "text" } format
        const response = await chat.sendMessage({ message: message });
        return {
          response: {
            text: () => response.text,
            candidates: [{ 
              content: { parts: [{ text: response.text }] } 
            }]
          }
        };
      }
    };
  }
};

module.exports = { model, ai };