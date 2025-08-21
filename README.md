# wrongo

Connect Cloudflare Workers 🌐 to MongoDB 🍃 through an API (_for SQL haters like me_).

## Features

- 🚀 **CRUD Operations**: Complete MongoDB operations (find, insert, update, delete)
- 🔐 **Basic Authentication**: Secure endpoints with basic auth
- 📊 **Index Management**: Create and drop indexes on collections
- 🧪 **Integration Testing**: Full test suite with real MongoDB containers
- 🔧 **Error Handling**: Comprehensive error handling
- 📝 **Request Validation**: Input validation for all endpoints

## Getting Started

### Prerequisites
- Node.js 22.18.0 or higher
- Docker (for testing with testcontainers)

### Local Development

```bash
npm install
npm test
```

## Testing

This project uses **Node.js native test runner** ([documentation](https://nodejs.org/api/test.html)) and **testcontainers** ([documentation](https://node.testcontainers.org/quickstart/usage/)) for comprehensive integration testing.

### Test Features

✅ **Real MongoDB Container**: Each test run uses a fresh MongoDB 7 container  
✅ **Full API Coverage**: Tests all endpoints with real HTTP requests  
✅ **Authentication Testing**: Verifies security requirements  
✅ **Error Handling**: Tests validation and error scenarios  
✅ **Automatic Cleanup**: Containers and connections cleaned up after tests  

## Docker Deployment

Docker images are automatically built and published to GitHub Container Registry on every push to the main branch. You can pull the latest image:

```bash
docker pull ghcr.io/itsjoekent/wrongo:latest
```

### Environment Variables

- `MONGODB_URL` - MongoDB connection string (required)
- `DB_NAME` - Database name to use (required)
- `AUTH_USERNAME` - Basic auth username (default: admin)
- `AUTH_PASSWORD` - Basic auth password (default: password)
- `PORT` - Server port (default: 3000)
- `DEBUG` - Enable debug mode for detailed error responses (default: false)

## Contributing

I built this for myself to use on side projects where I want a cheap database and a flexible schema. If you want to use it, cool! But I'm mostly sharing this for others to fork & reuse with their own Cloudflare Worker projects, I'm not actively seeking outside contributions or looking to maintain this for others 🙂

## License

Anti-Fascist MIT License
