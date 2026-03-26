/**
 * Origin Server — Cloud Processing Endpoint
 *
 * This Express server simulates a remote cloud data center that receives
 * raw IoT sensor data forwarded from the Cloudflare Worker. It performs
 * the EXACT same processing as the Worker's edge path, but the data
 * must travel from the edge to this server and back — incurring the
 * network round-trip cost that edge computing eliminates.
 *
 * Traditional cloud model — Shi et al. Section I:
 * "Things at the edge … request services from the cloud."
 *
 * Usage:
 *   node server.js
 *   # or with custom port and simulated latency:
 *   PORT=3001 SIMULATED_LATENCY_MS=50 node server.js
 *
 * @see Shi et al., "Edge Computing: Vision and Challenges", IEEE IoT Journal, 2016
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const SIMULATED_LATENCY_MS = parseInt(process.env.SIMULATED_LATENCY_MS || '50', 10);

// ── Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Request logger
app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url} — ${req.get('Content-Length') || 0} bytes`);
  next();
});

// ═════════════════════════════════════════════════════════════════
//  GET /health — Health check endpoint
// ═════════════════════════════════════════════════════════════════

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'edge-demo-origin',
    uptime: process.uptime(),
    simulated_latency_ms: SIMULATED_LATENCY_MS,
  });
});

// ═════════════════════════════════════════════════════════════════
//  POST /process — Process IoT sensor data (cloud path)
// ═════════════════════════════════════════════════════════════════
//
//  This endpoint performs the EXACT same processing as the Worker's
//  edge-process route:
//    1. Filter out-of-range readings
//    2. Aggregate: min, max, mean, standard deviation per sensor type
//    3. Detect anomalies (readings > 2σ from mean)
//
//  The artificial delay simulates the additional network hops and
//  queuing that occur in a real cloud data center environment.
//
//  Cloud offloading comparison — Shi et al. Section III-A:
//  This is the "before" scenario — all raw data travels to the
//  cloud for processing. The edge alternative (in the Worker)
//  processes data locally and only sends a compact summary.
// ═════════════════════════════════════════════════════════════════

app.post('/process', async (req, res) => {
  try {
    const { readings } = req.body;

    if (!Array.isArray(readings)) {
      return res.status(400).json({ error: '"readings" must be an array' });
    }

    // ── Simulate data center processing latency ─────────────────
    // In a real deployment, this delay represents the network hops,
    // load balancer routing, and compute queue time in a centralized
    // cloud environment.
    if (SIMULATED_LATENCY_MS > 0) {
      await sleep(SIMULATED_LATENCY_MS);
    }

    // ── Process the data (identical logic to the Worker) ────────
    const result = processSensorData(readings, 'cloud');

    console.log(
      `  → Processed ${readings.length} readings → ${result.summary.valid_readings} valid, ` +
      `${result.anomalies.length} anomalies detected`
    );

    res.json(result);
  } catch (err) {
    console.error('  → Error processing data:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════
//  Core Data Processing Logic
// ═════════════════════════════════════════════════════════════════
//
//  IMPORTANT: This logic is intentionally IDENTICAL to the Worker's
//  processSensorData() function. The whole point of the demo is that
//  the same computation can run at the edge OR in the cloud — the
//  difference is WHERE it runs, not WHAT it does.
//
//  Optimization metrics — Shi et al. Section III-F:
//  When this runs in the cloud, the ENTIRE raw payload must travel
//  across the network. When the identical logic runs at the edge,
//  only the compact summary crosses the network.
// ═════════════════════════════════════════════════════════════════

/** Valid ranges for each sensor type (used for filtering) */
const VALID_RANGES = {
  temperature: { min: -40, max: 60 },    // °C
  humidity:    { min: 0,   max: 100 },    // %
  pressure:    { min: 900, max: 1100 },   // hPa
  vibration:   { min: 0,   max: 50 },     // mm/s
};

/**
 * Process an array of sensor readings:
 * filter → aggregate → anomaly detect.
 *
 * @param {Array} readings - Array of sensor reading objects
 * @param {string} location - Processing location label
 * @returns {Object} Processed result with summary and anomalies
 */
function processSensorData(readings, location) {
  const totalReadings = readings.length;

  // ── Step 1: Filter out-of-range readings ──────────────────────
  const validReadings = readings.filter((r) => {
    const range = VALID_RANGES[r.sensor_type];
    if (!range) return true;
    return r.value >= range.min && r.value <= range.max;
  });

  const filteredOut = totalReadings - validReadings.length;

  // ── Step 2: Group by sensor type ──────────────────────────────
  const groups = {};
  for (const reading of validReadings) {
    if (!groups[reading.sensor_type]) {
      groups[reading.sensor_type] = [];
    }
    groups[reading.sensor_type].push(reading.value);
  }

  // ── Step 3: Compute aggregates per sensor type ────────────────
  const sensorTypes = {};
  for (const [stype, values] of Object.entries(groups)) {
    sensorTypes[stype] = computeStats(values);
  }

  // ── Step 4: Detect statistical anomalies ──────────────────────
  const anomalies = [];
  for (const reading of validReadings) {
    const stats = sensorTypes[reading.sensor_type];
    if (!stats || stats.std_dev === 0) continue;

    const zScore = Math.abs(reading.value - stats.mean) / stats.std_dev;
    if (zScore > 2) {
      anomalies.push({
        sensor_id: reading.sensor_id,
        sensor_type: reading.sensor_type,
        value: reading.value,
        mean: stats.mean,
        std_dev: stats.std_dev,
        reason: `Value ${reading.value.toFixed(1)} is ${zScore.toFixed(1)}σ from mean (${stats.mean.toFixed(1)} ± ${stats.std_dev.toFixed(1)})`,
      });
    }
  }

  return {
    summary: {
      total_readings: totalReadings,
      valid_readings: validReadings.length,
      filtered_out: filteredOut,
      sensor_types: sensorTypes,
      processing_location: location,
      processed_at: new Date().toISOString(),
    },
    anomalies,
  };
}

/**
 * Compute min, max, mean, and standard deviation for an array of numbers.
 *
 * @param {number[]} values
 * @returns {{ count: number, min: number, max: number, mean: number, std_dev: number }}
 */
function computeStats(values) {
  const count = values.length;
  if (count === 0) return { count: 0, min: 0, max: 0, mean: 0, std_dev: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / count;

  // Standard deviation (population)
  const sqDiffs = values.map((v) => Math.pow(v - mean, 2));
  const avgSqDiff = sqDiffs.reduce((a, b) => a + b, 0) / count;
  const std_dev = Math.sqrt(avgSqDiff);

  return { count, min, max, mean, std_dev };
}

// ═════════════════════════════════════════════════════════════════
//  Utility
// ═════════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═════════════════════════════════════════════════════════════════
//  Start Server
// ═════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Edge Computing Demo — Origin (Cloud) Server           ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Port:              ${PORT}                               ║`);
  console.log(`║  Simulated Latency: ${String(SIMULATED_LATENCY_MS).padEnd(4)} ms                            ║`);
  console.log('║  Endpoints:                                            ║');
  console.log('║    POST /process  — Process IoT sensor data            ║');
  console.log('║    GET  /health   — Health check                       ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Paper: Shi et al., "Edge Computing: Vision and        ║');
  console.log('║         Challenges" (IEEE IoT Journal, 2016)           ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
});
