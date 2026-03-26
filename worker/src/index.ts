/**
 * Edge Computing Demo — Cloudflare Worker
 *
 * Demonstrates the core value proposition from Shi et al. (2016):
 * "Edge Computing: Vision and Challenges" — processing data at the
 * edge instead of sending everything to a central cloud server.
 *
 * Routes:
 *   GET  /                  → Serves the demo UI
 *   POST /api/edge-process  → Edge processing path (cloud offloading)
 *   POST /api/cloud-forward → Cloud forwarding path (traditional round-trip)
 *   POST /api/generate-data → Generates random IoT sensor data
 *
 * @see Shi et al., IEEE IoT Journal, vol. 3, no. 5, pp. 637–646, Oct. 2016
 */

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

/** Environment bindings provided by wrangler.jsonc */
interface Env {
  ORIGIN_URL: string;
}

/** A single IoT sensor reading */
interface SensorReading {
  sensor_id: string;
  sensor_type: 'temperature' | 'humidity' | 'pressure' | 'vibration';
  timestamp: string;
  value: number;
  unit: string;
  location: { lat: number; lon: number };
}

/** Aggregated statistics for one sensor type */
interface SensorStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  std_dev: number;
}

/** An anomaly detected during processing */
interface Anomaly {
  sensor_id: string;
  sensor_type: string;
  value: number;
  mean: number;
  std_dev: number;
  reason: string;
}

/** The processed result returned by both edge and cloud paths */
interface ProcessedResult {
  summary: {
    total_readings: number;
    valid_readings: number;
    filtered_out: number;
    sensor_types: Record<string, SensorStats>;
    processing_location: string;
    processed_at: string;
  };
  anomalies: Anomaly[];
}

// ═══════════════════════════════════════════════════════════════════
// Inline HTML — imported at build time or served as string
// ═══════════════════════════════════════════════════════════════════

// The UI HTML is embedded directly in the Worker bundle.
// In production, you could use `wrangler` text bindings, but for
// simplicity and zero-build-step presentation clarity, we inline it.
import HTML_CONTENT from './ui.html';

// ═══════════════════════════════════════════════════════════════════
// Main Worker Entry Point
// ═══════════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers applied to every response
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers':
        'X-Processing-Location, X-Edge-City, X-Raw-Data-Size, X-Processed-Data-Size, X-Origin-URL',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // ── Route Dispatch ────────────────────────────────────────
      switch (url.pathname) {
        case '/':
          return serveUI(corsHeaders);

        case '/api/edge-process':
          return handleEdgeProcess(request, corsHeaders);

        case '/api/cloud-forward':
          return handleCloudForward(request, env, corsHeaders);

        case '/api/generate-data':
          return handleGenerateData(request, corsHeaders);

        default:
          return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return jsonResponse({ error: message }, 500, corsHeaders);
    }
  },
} satisfies ExportedHandler<Env>;

// ═══════════════════════════════════════════════════════════════════
//  GET / — Serve the Demo UI
// ═══════════════════════════════════════════════════════════════════

function serveUI(corsHeaders: Record<string, string>): Response {
  return new Response(HTML_CONTENT, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-cache',
      ...corsHeaders,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
//  POST /api/edge-process — Edge Processing Path
// ═══════════════════════════════════════════════════════════════════
//
//  Cloud offloading — Shi et al. Section III-A:
//  "Cache the operation at the edge, not just the data."
//
//  The Worker receives raw IoT sensor data and performs all
//  processing (filter → aggregate → anomaly detect) RIGHT HERE
//  at the nearest Cloudflare PoP. The raw data never leaves the
//  edge; only a compact summary is returned.
//
//  This demonstrates the paper's core insight: reduce data
//  movement by processing where data originates.
// ═══════════════════════════════════════════════════════════════════

async function handleEdgeProcess(
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.text();
  const rawSize = new TextEncoder().encode(body).length;
  const { readings } = JSON.parse(body) as { readings: SensorReading[] };

  if (!Array.isArray(readings)) {
    return jsonResponse({ error: '"readings" must be an array' }, 400, corsHeaders);
  }

  // ── Process data at the edge ──────────────────────────────────
  const result = processSensorData(readings, 'edge');

  // Calculate response size
  const responseBody = JSON.stringify(result);
  const processedSize = new TextEncoder().encode(responseBody).length;

  // Attempt to read the edge city from the Cloudflare cf object
  // @ts-ignore — cf is available at runtime on Cloudflare Workers
  const city: string = (request as any).cf?.city ?? 'local-dev';

  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // ── Custom headers for the demo UI metrics ─────────────
      'X-Processing-Location': 'edge',
      'X-Edge-City': city,
      'X-Raw-Data-Size': String(rawSize),
      'X-Processed-Data-Size': String(processedSize),
      ...corsHeaders,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
//  POST /api/cloud-forward — Cloud Forwarding Path
// ═══════════════════════════════════════════════════════════════════
//
//  Traditional cloud model — Shi et al. Section I:
//  "Things at the edge … request services from the cloud."
//
//  The Worker acts as a thin proxy: it receives the raw IoT data
//  and forwards the ENTIRE payload to a remote origin server for
//  processing. The origin performs the same computation and
//  returns the result through the Worker.
//
//  This simulates the latency and bandwidth cost of sending all
//  raw data to a centralized cloud — the pattern the paper
//  argues against for latency-sensitive IoT workloads.
// ═══════════════════════════════════════════════════════════════════

async function handleCloudForward(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.text();
  const rawSize = new TextEncoder().encode(body).length;

  // @ts-ignore — cf is available at runtime
  const city: string = (request as any).cf?.city ?? 'local-dev';

  const originUrl = env.ORIGIN_URL.replace(/\/+$/, '') + '/process';

  // ── Forward entire raw payload to origin server ───────────────
  let originResponse: Response;
  try {
    originResponse = await fetch(originUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });
  } catch (err) {
    // If the origin is unreachable, fall back to local processing
    // with a simulated delay so the demo still works without an
    // origin server running.
    const fallback = await simulateCloudProcessing(body);
    const processedSize = new TextEncoder().encode(fallback).length;

    return new Response(fallback, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Processing-Location': 'cloud (simulated — origin unreachable)',
        'X-Edge-City': city,
        'X-Origin-URL': originUrl,
        'X-Raw-Data-Size': String(rawSize),
        'X-Processed-Data-Size': String(processedSize),
        ...corsHeaders,
      },
    });
  }

  const originBody = await originResponse.text();
  const processedSize = new TextEncoder().encode(originBody).length;

  return new Response(originBody, {
    status: originResponse.status,
    headers: {
      'Content-Type': 'application/json',
      'X-Processing-Location': 'cloud',
      'X-Edge-City': city,
      'X-Origin-URL': originUrl,
      'X-Raw-Data-Size': String(rawSize),
      'X-Processed-Data-Size': String(processedSize),
      ...corsHeaders,
    },
  });
}

/**
 * Fallback: simulate cloud latency + processing when origin is down.
 * Adds an artificial 150ms delay to approximate a real origin round-trip.
 */
async function simulateCloudProcessing(body: string): Promise<string> {
  // Simulate network round-trip latency (150ms)
  await new Promise((resolve) => setTimeout(resolve, 150));

  const { readings } = JSON.parse(body) as { readings: SensorReading[] };
  const result = processSensorData(readings, 'cloud (simulated)');
  return JSON.stringify(result);
}

// ═══════════════════════════════════════════════════════════════════
//  POST /api/generate-data — Generate Random IoT Sensor Data
// ═══════════════════════════════════════════════════════════════════
//
//  Creates realistic IoT sensor readings with deliberate anomalies.
//  Sensor types map to real-world units:
//    - temperature: °C (normal: -10 to 45)
//    - humidity:    %  (normal: 20 to 90)
//    - pressure:    hPa (normal: 980 to 1040)
//    - vibration:   mm/s (normal: 0 to 15)
//
//  ~5% of readings are injected as out-of-range anomalies.
// ═══════════════════════════════════════════════════════════════════

async function handleGenerateData(
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  let count = 100;

  // Allow the client to request a specific count
  if (request.method === 'POST') {
    try {
      const body = await request.json() as { count?: number };
      if (body.count && typeof body.count === 'number') {
        count = Math.min(Math.max(body.count, 10), 500);
      }
    } catch {
      // Use default count if body parsing fails
    }
  }

  const readings = generateSensorReadings(count);
  const payload = JSON.stringify({ readings });
  const rawBytes = new TextEncoder().encode(payload).length;

  // Count anomalies
  const anomalyCount = readings.filter((r) => isAnomalous(r)).length;

  const responseBody = JSON.stringify({
    readings,
    raw_bytes: rawBytes,
    anomaly_count: anomalyCount,
    generated_at: new Date().toISOString(),
  });

  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Core Data Processing Logic
// ═══════════════════════════════════════════════════════════════════
//
//  This is the "operation" that gets cached at the edge in the
//  cloud offloading model. The same logic runs in both the Worker
//  (edge) and the origin server (cloud) — the only difference is
//  WHERE it executes.
//
//  Processing steps:
//    1. Filter out-of-range readings (data quality)
//    2. Group by sensor type
//    3. Compute aggregates: min, max, mean, standard deviation
//    4. Detect anomalies: readings > 2σ from mean
//
//  Optimization metrics — Shi et al. Section III-F:
//  By processing at the edge, we co-optimize:
//    - Latency:   no round-trip to remote origin
//    - Bandwidth: only compact summary crosses the network
//    - Cost:      reduced data transfer = reduced cloud bills
// ═══════════════════════════════════════════════════════════════════

/** Valid ranges for each sensor type (used for filtering) */
const VALID_RANGES: Record<string, { min: number; max: number }> = {
  temperature: { min: -40, max: 60 },    // °C
  humidity:    { min: 0,   max: 100 },    // %
  pressure:    { min: 900, max: 1100 },   // hPa
  vibration:   { min: 0,   max: 50 },     // mm/s
};

/**
 * Process an array of sensor readings:
 * filter → aggregate → anomaly detect.
 */
function processSensorData(
  readings: SensorReading[],
  location: string,
): ProcessedResult {
  const totalReadings = readings.length;

  // ── Step 1: Filter out-of-range readings ──────────────────────
  // Remove readings where the value is physically impossible
  // (e.g., temperature of 999°C is sensor malfunction, not anomaly)
  const validReadings = readings.filter((r) => {
    const range = VALID_RANGES[r.sensor_type];
    if (!range) return true;
    return r.value >= range.min && r.value <= range.max;
  });

  const filteredOut = totalReadings - validReadings.length;

  // ── Step 2: Group by sensor type ──────────────────────────────
  const groups: Record<string, number[]> = {};
  for (const reading of validReadings) {
    if (!groups[reading.sensor_type]) {
      groups[reading.sensor_type] = [];
    }
    groups[reading.sensor_type].push(reading.value);
  }

  // ── Step 3: Compute aggregates per sensor type ────────────────
  const sensorTypes: Record<string, SensorStats> = {};
  for (const [stype, values] of Object.entries(groups)) {
    sensorTypes[stype] = computeStats(values);
  }

  // ── Step 4: Detect statistical anomalies ──────────────────────
  //  A reading is anomalous if it's more than 2 standard deviations
  //  from the mean for its sensor type. These are valid readings
  //  (within physical range) but statistically unusual — potential
  //  indicators of equipment issues or environmental events.
  const anomalies: Anomaly[] = [];
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
 */
function computeStats(values: number[]): SensorStats {
  const count = values.length;
  if (count === 0) return { count: 0, min: 0, max: 0, mean: 0, std_dev: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / count;

  // Standard deviation (population)
  const sqDiffs = values.map((v) => (v - mean) ** 2);
  const avgSqDiff = sqDiffs.reduce((a, b) => a + b, 0) / count;
  const std_dev = Math.sqrt(avgSqDiff);

  return { count, min, max, mean, std_dev };
}

// ═══════════════════════════════════════════════════════════════════
//  IoT Data Generator
// ═══════════════════════════════════════════════════════════════════

/** Sensor type definitions with realistic value ranges */
const SENSOR_DEFS = [
  { type: 'temperature' as const, unit: '°C',   normalMin: -10, normalMax: 45,  anomalyValues: [-55, 75, 99, -80] },
  { type: 'humidity'    as const, unit: '%',     normalMin: 20,  normalMax: 90,  anomalyValues: [-10, 110, 150]    },
  { type: 'pressure'    as const, unit: 'hPa',   normalMin: 980, normalMax: 1040, anomalyValues: [800, 1200, 500]  },
  { type: 'vibration'   as const, unit: 'mm/s',  normalMin: 0,   normalMax: 15,  anomalyValues: [-5, 60, 80]      },
];

/** Simulated facility locations (lat/lon) */
const LOCATIONS = [
  { lat: 43.9454, lon: -78.8968 },  // Oshawa, ON (Ontario Tech)
  { lat: 43.6532, lon: -79.3832 },  // Toronto, ON
  { lat: 45.5017, lon: -73.5673 },  // Montreal, QC
  { lat: 51.0447, lon: -114.0719 }, // Calgary, AB
  { lat: 49.2827, lon: -123.1207 }, // Vancouver, BC
];

/**
 * Generate an array of realistic IoT sensor readings.
 * ~5% of readings are deliberately anomalous (out-of-range values).
 */
function generateSensorReadings(count: number): SensorReading[] {
  const readings: SensorReading[] = [];
  const now = Date.now();
  const anomalyRate = 0.05; // 5% anomaly injection rate

  for (let i = 0; i < count; i++) {
    const def = SENSOR_DEFS[i % SENSOR_DEFS.length];
    const loc = LOCATIONS[i % LOCATIONS.length];
    const isAnomaly = Math.random() < anomalyRate;

    let value: number;
    if (isAnomaly) {
      // Pick a random out-of-range anomaly value
      value = def.anomalyValues[Math.floor(Math.random() * def.anomalyValues.length)];
    } else {
      // Generate a normal value within the realistic range
      value = def.normalMin + Math.random() * (def.normalMax - def.normalMin);
      // Add slight Gaussian-like noise for realism
      value += (Math.random() - 0.5) * (def.normalMax - def.normalMin) * 0.1;
    }

    readings.push({
      sensor_id: `sensor-${String(i + 1).padStart(3, '0')}`,
      sensor_type: def.type,
      timestamp: new Date(now - (count - i) * 1000).toISOString(),
      value: parseFloat(value.toFixed(2)),
      unit: def.unit,
      location: {
        lat: loc.lat + (Math.random() - 0.5) * 0.01,
        lon: loc.lon + (Math.random() - 0.5) * 0.01,
      },
    });
  }

  return readings;
}

/**
 * Check if a reading falls outside the valid physical range.
 * Used only by the data generator to count injected anomalies.
 */
function isAnomalous(reading: SensorReading): boolean {
  const range = VALID_RANGES[reading.sensor_type];
  if (!range) return false;
  return reading.value < range.min || reading.value > range.max;
}

// ═══════════════════════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════════════════════

/** Create a JSON response with the given status and headers */
function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
