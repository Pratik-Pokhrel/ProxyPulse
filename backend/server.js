const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || 'unknown';

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from backend',
    instance: INSTANCE_ID,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', instance: INSTANCE_ID });
});

// deliberately a bit expensive, this is the route you point the
// nginx micro-cache at, so you can measure how much load caching
// takes off the backend nodes
app.get('/hot', (req, res) => {
  let sum = 0;
  for (let i = 0; i < 1e6; i++) sum += i;
  res.json({
    instance: INSTANCE_ID,
    computed: sum,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Instance ${INSTANCE_ID} listening on port ${PORT}`);
});
