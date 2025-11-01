# database-service

Team: **platform-team**

Dependencies: None

---

# Service Dependency Demo - Template Service

This is a template service for the service-dependency-demo-infra demo. It demonstrates:

- Fetching database credentials from AWS Secrets Manager
- Periodic database health checks (every 30 seconds)
- Periodic dependency health checks (every 30 seconds)
- Health check endpoint for monitoring

## Environment Variables

- `SERVICE_NAME` - Name of this service (for logging)
- `PORT` - HTTP server port (default: 3000)
- `DB_SECRET_ARN` - ARN of the AWS Secrets Manager secret containing database credentials
- `DEPENDENCIES` - JSON array of dependency URLs (e.g., `["http://service1:3000", "http://service2:3000"]`)
- `AWS_REGION` - AWS region for Secrets Manager (default: us-east-1)

## Endpoints

- `GET /` - Service information
- `GET /health` - Health check endpoint

## Health Check Response

```json
{
  "service": "my-service",
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "database": "connected",
  "dependencies": {
    "http://service1:3000": true,
    "http://service2:3000": false
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Docker

```bash
# Build the image
docker build -t service-dependency-demo-infra-service .

# Run the container
docker run -p 3000:3000 \
  -e SERVICE_NAME=my-service \
  -e DB_SECRET_ARN=arn:aws:secretsmanager:... \
  -e DEPENDENCIES='["http://dep1:3000"]' \
  service-dependency-demo-infra-service
```
