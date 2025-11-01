import express, { type Request, type Response } from 'express';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

const { Pool } = pg;

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;
const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown-service';
const DEPENDENCIES = process.env.DEPENDENCIES
  ? JSON.parse(process.env.DEPENDENCIES)
  : [];
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Ping intervals (1 minute)
const PING_INTERVAL = 60_000;

// Global state
let dbPool: pg.Pool | null = null;
let isHealthy = false;
let dbConnectionString: string | null = null;
const dependencyHealth: Map<string, boolean> = new Map();

/**
 * Fetch database connection string from AWS Secrets Manager
 */
async function fetchDatabaseCredentials(): Promise<string> {
  if (!DB_SECRET_ARN) {
    throw new Error('DB_SECRET_ARN environment variable is required');
  }

  console.log(`[${SERVICE_NAME}] Fetching database credentials from Secrets Manager...`);
  console.log(`[${SERVICE_NAME}] Secret ARN: ${DB_SECRET_ARN}`);

  const client = new SecretsManagerClient({ region: AWS_REGION });

  try {
    const command = new GetSecretValueCommand({ SecretId: DB_SECRET_ARN });
    const response = await client.send(command);

    if (!response.SecretString) {
      throw new Error('Secret value is empty');
    }

    // Parse the secret (assuming it's JSON with a 'connectionString' field)
    const secret = JSON.parse(response.SecretString);
    const connectionString = secret.connectionString || secret.url || secret.dbUrl;

    if (!connectionString) {
      throw new Error('No connection string found in secret');
    }

    console.log(`[${SERVICE_NAME}] Successfully fetched database credentials`);
    return connectionString;
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to fetch database credentials:`, error);
    throw error;
  }
}

/**
 * Initialize database connection pool
 */
async function initializeDatabase(): Promise<void> {
  try {
    dbConnectionString = await fetchDatabaseCredentials();

    dbPool = new Pool({
      connectionString: dbConnectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: {
        rejectUnauthorized: false, // Accept RDS self-signed certificates (demo only)
      },
    });

    // Test the connection
    const client = await dbPool.connect();
    console.log(`[${SERVICE_NAME}] Database connection established`);
    client.release();

    isHealthy = true;
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to initialize database:`, error);
    isHealthy = false;
  }
}

/**
 * Ping the database to ensure it's alive
 * If database pool is not initialized, attempt to initialize it
 */
async function pingDatabase(): Promise<void> {
  // If pool not initialized, try to initialize it
  if (!dbPool) {
    console.warn(`[${SERVICE_NAME}] Database pool not initialized, attempting to initialize...`);
    await initializeDatabase();
    return; // Exit after initialization attempt, next ping will verify
  }

  try {
    const start = Date.now();
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
    const duration = Date.now() - start;

    console.log(`[${SERVICE_NAME}] Database ping successful (${duration}ms)`);
    isHealthy = true;
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Database ping failed:`, error);
    isHealthy = false;

    // If ping fails, destroy the pool and force reinitialization on next ping
    if (dbPool) {
      await dbPool.end().catch(() => {
        // Ignore errors during pool cleanup
      });
      dbPool = null;
      console.warn(`[${SERVICE_NAME}] Database pool destroyed, will reinitialize on next ping`);
    }
  }
}

/**
 * Ping a dependency service
 */
async function pingDependency(dependencyUrl: string): Promise<boolean> {
  try {
    const start = Date.now();
    const response = await fetch(`${dependencyUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    const duration = Date.now() - start;

    const success = response.ok;
    console.log(
      `[${SERVICE_NAME}] Dependency ${dependencyUrl} ping ${success ? 'successful' : 'failed'} (${duration}ms)`
    );
    return success;
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to ping dependency ${dependencyUrl}:`, error);
    return false;
  }
}

/**
 * Ping all dependencies
 */
async function pingDependencies(): Promise<void> {
  if (DEPENDENCIES.length === 0) {
    return;
  }

  console.log(`[${SERVICE_NAME}] Pinging ${DEPENDENCIES.length} dependencies...`);

  const results = await Promise.allSettled(
    DEPENDENCIES.map(async (dep: string) => {
      const healthy = await pingDependency(dep);
      dependencyHealth.set(dep, healthy);
      return { dep, healthy };
    })
  );

  const successCount = results.filter(
    (r) => r.status === 'fulfilled' && r.value.healthy
  ).length;

  console.log(
    `[${SERVICE_NAME}] Dependency health check: ${successCount}/${DEPENDENCIES.length} healthy`
  );
}

/**
 * Start periodic ping timers
 */
function startPingTimers(): void {
  // Database ping every 30 seconds
  setInterval(() => {
    void pingDatabase();
  }, PING_INTERVAL);

  // Dependencies ping every 30 seconds
  if (DEPENDENCIES.length > 0) {
    setInterval(() => {
      void pingDependencies();
    }, PING_INTERVAL);
  }

  console.log(`[${SERVICE_NAME}] Ping timers started (interval: ${PING_INTERVAL}ms)`);
}

/**
 * Graceful shutdown handler
 */
async function shutdown(): Promise<void> {
  console.log(`[${SERVICE_NAME}] Shutting down gracefully...`);

  if (dbPool) {
    await dbPool.end();
    console.log(`[${SERVICE_NAME}] Database pool closed`);
  }

  process.exit(0);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log(`[${SERVICE_NAME}] Starting service...`);
  console.log(`[${SERVICE_NAME}] Service name: ${SERVICE_NAME}`);
  console.log(`[${SERVICE_NAME}] Dependencies: ${DEPENDENCIES.length}`);
  console.log(`[${SERVICE_NAME}] AWS Region: ${AWS_REGION}`);

  // Initialize Express app
  const app = express();

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    const healthStatus = {
      service: SERVICE_NAME,
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database: isHealthy ? 'connected' : 'disconnected',
      dependencies: Object.fromEntries(dependencyHealth),
    };

    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json(healthStatus);
  });

  // Root endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: SERVICE_NAME,
      message: 'Credential Leak Demo Service',
      endpoints: {
        health: '/health',
      },
    });
  });

  // Start Express server
  const server = app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] HTTP server listening on port ${PORT}`);
  });

  // Initialize database connection
  // Note: If RDS is not ready yet, initial connection will fail
  // The periodic ping timer will automatically retry initialization
  await initializeDatabase();

  // Do initial ping of dependencies
  if (DEPENDENCIES.length > 0) {
    await pingDependencies();
  }

  // Start periodic ping timers
  startPingTimers();

  // Setup graceful shutdown
  process.on('SIGTERM', () => {
    console.log(`[${SERVICE_NAME}] SIGTERM received`);
    server.close(() => {
      void shutdown();
    });
  });

  process.on('SIGINT', () => {
    console.log(`[${SERVICE_NAME}] SIGINT received`);
    server.close(() => {
      void shutdown();
    });
  });

  console.log(`[${SERVICE_NAME}] Service started successfully`);
}

// Start the service
main().catch((error) => {
  console.error(`[${SERVICE_NAME}] Fatal error:`, error);
  process.exit(1);
});
