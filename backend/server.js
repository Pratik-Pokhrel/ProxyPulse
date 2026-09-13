const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || "unknown";

app.get("/", (req, res) => {
  res.json({
    message: "Hello from backend",
    instance: INSTANCE_ID,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", instance: INSTANCE_ID });
});

/* This is deliberately a bit expensive, this is the route that is pointed to the
   nginx micro-cache at, so to measure how much load caching takes off the backend nodes
*/
app.get("/hot", (req, res) => {
  let sum = 0;
  for (let i = 0; i < 1e6; i++) sum += i; // this extensively burns the CPU, so we can see the effect of caching on the backend load
  res.json({
    instance: INSTANCE_ID,
    computed: sum,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Instance ${INSTANCE_ID} listening on port ${PORT}`);
});

// To trigger the image build
