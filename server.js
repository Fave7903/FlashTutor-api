const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const config = require('./config');

// Import routes
const chatRoutes = require('./routes/chat');
const tutorialRoutes = require('./routes/tutorial');
const processFileRoutes = require('./routes/processFile');
const quizRoutes = require('./routes/quiz');
const QreditService = require('./services/qreditService'); // 👈 Adjust path if needed

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Routes
app.use('/', chatRoutes);
app.use('/', tutorialRoutes);
app.use('/', processFileRoutes);
app.use('/', quizRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// 🛑 DELETE THIS ROUTE BEFORE PRODUCTION
app.post('/api/test-deduct', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    const result = await QreditService.deduct(userId, amount, 'Manual Test Charge');
    res.json(result);
  } catch (error) {
    // If it throws "INSUFFICIENT_FUNDS", send a 402 status
    if (error.code === 'INSUFFICIENT_FUNDS') {
      return res.status(402).json(error);
    }
    res.status(500).json({ error: error.message });
  }
});

// Start server
const port = config.port;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app;
