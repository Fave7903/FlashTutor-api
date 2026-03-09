const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const config = require('./config');

// Import routes
const chatRoutes = require('./routes/chat');
const tutorialRoutes = require('./routes/tutorial');
const processFileRoutes = require('./routes/processFile');
const quizRoutes = require('./routes/quiz');
const paymentRoutes = require('./routes/paymentRoutes');

const app = express();

// Middleware
app.use(cors());
// app.use(bodyParser.json());
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    // This catches the raw buffer before it's parsed to JSON
    req.rawBody = buf;
  }
}));

// Routes
app.use('/', chatRoutes);
app.use('/', tutorialRoutes);
app.use('/', processFileRoutes);
app.use('/', quizRoutes);
app.use('/', paymentRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// Start server
const port = config.port;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app;
