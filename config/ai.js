const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require('./index');

const genAI = new GoogleGenerativeAI(config.apiKey);
const model = genAI.getGenerativeModel({ model: config.modelName });

module.exports = { model, genAI };

