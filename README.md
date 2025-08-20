# wrongo

Connect Cloudflare Workers 🌐 to MongoDB 💾 through an API (for SQL haters like me).

## Using Docker Compose (Recommended)
```bash
# Build and test (database starts fresh every time)
docker compose build && docker compose up -d && docker compose run --rm api-tests

# Or step by step:
# 1. Rebuild containers
docker compose build

# 2. Start services (fresh database)
docker compose up -d

# 3. Run tests
docker compose run --rm api-tests

# Quick manual test
curl -u admin:password http://localhost:3000/

# Stop services
docker compose down
```

## Authentication

All endpoints are protected with HTTP Basic Authentication. You must provide a username and password to access any endpoint.

## API Endpoints

All endpoints return JSON responses with a consistent structure:
- Success: `{ "success": true, "data": ..., ... }`
- Error: `{ "error": "message", "details": "..." }`

### Health Check
- **GET** `/` - Returns API status

### Database Operations

#### Find Documents
- **POST** `/v0/find`
```json
{
  "collection": "users",
  "filter": { "age": { "$gte": 18 } },
  "options": { "limit": 10, "sort": { "name": 1 } }
}
```

#### Find One Document
- **POST** `/v0/find-one`
```json
{
  "collection": "users",
  "filter": { "_id": "507f1f77bcf86cd799439011" }
}
```

#### Insert One Document
- **POST** `/v0/insert-one`
```json
{
  "collection": "users",
  "document": { "name": "John", "age": 30, "email": "john@example.com" }
}
```

#### Insert Many Documents
- **POST** `/v0/insert-many`
```json
{
  "collection": "users",
  "documents": [
    { "name": "Alice", "age": 25 },
    { "name": "Bob", "age": 35 }
  ]
}
```

#### Update One Document
- **POST** `/v0/update-one`
```json
{
  "collection": "users",
  "filter": { "_id": "507f1f77bcf86cd799439011" },
  "update": { "$set": { "age": 31 } },
  "options": { "upsert": true }
}
```

#### Update Many Documents
- **POST** `/v0/update-many`
```json
{
  "collection": "users",
  "filter": { "age": { "$lt": 18 } },
  "update": { "$set": { "status": "minor" } }
}
```

#### Delete One Document
- **POST** `/v0/delete-one`
```json
{
  "collection": "users",
  "filter": { "_id": "507f1f77bcf86cd799439011" }
}
```

#### Delete Many Documents
- **POST** `/v0/delete-many`
```json
{
  "collection": "users",
  "filter": { "status": "inactive" }
}
```

#### Count Documents
- **POST** `/v0/count`
```json
{
  "collection": "users",
  "filter": { "age": { "$gte": 18 } }
}
```

#### List Collections
- **GET** `/v0/collections` - Returns all collection names in the database

### Index Management

#### Create Index
- **POST** `/v0/create-index`
```json
{
  "collection": "users",
  "keys": { "email": 1 },
  "options": { "unique": true, "name": "email_unique" }
}
```

**Note**: Creating indexes is **idempotent** - calling `createIndex` multiple times with the same specification is safe and will not cause errors.

#### Drop Index
- **POST** `/v0/drop-index`
```json
{
  "collection": "users",
  "index": "email_unique"
}
```

## Example Usage

### Using curl

```bash
# Find all users
curl -X POST http://admin:password@localhost:3000/v0/find \
  -H "Content-Type: application/json" \
  -d '{"collection": "users", "filter": {}}'

# Insert a new user
curl -X POST http://admin:password@localhost:3000/v0/insert-one \
  -H "Content-Type: application/json" \
  -d '{"collection": "users", "document": {"name": "Jane", "age": 28}}'

# Update a user
curl -X POST http://admin:password@localhost:3000/v0/update-one \
  -H "Content-Type: application/json" \
  -d '{"collection": "users", "filter": {"name": "Jane"}, "update": {"$set": {"age": 29}}}'

# Create an index (safe to run multiple times)
curl -X POST http://admin:password@localhost:3000/v0/create-index \
  -H "Content-Type: application/json" \
  -d '{"collection": "users", "keys": {"email": 1}, "options": {"unique": true}}'
```

### Using JavaScript/Node.js

```javascript
const API_BASE = 'http://localhost:3000/v0';

// Find documents
async function findUsers() {
  const response = await fetch(`${API_BASE}/find`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa('admin:password')
    },
    body: JSON.stringify({
      collection: 'users',
      filter: { age: { $gte: 18 } }
    })
  });
  return response.json();
}

// Insert a document
async function createUser(userData) {
  const response = await fetch(`${API_BASE}/insert-one`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa('admin:password')
    },
    body: JSON.stringify({
      collection: 'users',
      document: userData
    })
  });
  return response.json();
}
```

## Error Handling

The API returns appropriate HTTP status codes:
- `200` - Success
- `400` - Bad Request (missing required fields, invalid data)
- `500` - Internal Server Error (database errors)

Example error response:
```json
{
  "error": "Failed to find documents",
  "details": "Collection 'nonexistent' not found"
}
```

## Security Considerations

⚠️ **Important**: This API includes basic HTTP authentication but is still intended for development or internal use. For production:

1. ✅ Basic authentication implemented - configure strong credentials via environment variables
2. Implement rate limiting
3. Validate and sanitize inputs
4. Add CORS configuration if needed
5. Use HTTPS
6. Restrict database operations based on user permissions
7. Consider implementing role-based access control
8. Use more secure authentication methods (JWT, OAuth, etc.)

## MongoDB Connection

The API connects to MongoDB using the official MongoDB driver. Ensure your MongoDB instance is running and accessible at the configured URL. 