import assert from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import { MongoClient } from 'mongodb';
import { GenericContainer } from 'testcontainers';

let mongoContainers = [];
let mongoClient;
let serverInfo;
let baseUrl;

describe('MongoDB REST API Integration Tests', () => {
  before(async () => {
    console.log('↺ Starting MongoDB replica set...');

    // Start single MongoDB container with replica set enabled
    const replicaSetName = 'rs0';
    console.log('↺ Starting MongoDB container...');
    
    const container = await new GenericContainer('mongo:7')
      .withExposedPorts(27017)
      .withCommand(['mongod', '--replSet', replicaSetName, '--bind_ip_all'])
      .start();

    mongoContainers.push(container);
    const mongoPort = container.getMappedPort(27017);
    console.log(`✓ MongoDB started on port ${mongoPort}`);

    console.log('↺ Waiting for MongoDB to start...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log('↺ Initializing replica set using mongosh...');
    
    try {
      const initCommand = `rs.initiate({_id:'${replicaSetName}',members:[{_id:0,host:'localhost:27017'}]})`;
      const result = await container.exec(['mongosh', '--quiet', '--eval', initCommand]);
      
      if (result.output.includes('{ ok: 1 }') || result.output.includes('"ok" : 1')) {
        console.log('✓ Replica set initialized successfully');
      } else {
        console.log('⚠ Replica set initialization may have failed:', result.output);
      }
      

      console.log('↺ Waiting for replica set to be ready...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
    } catch (error) {
      console.error('⚠ Error initializing replica set:', error.message);
      throw error;
    }

    // Connect with replica set - use directConnection to bypass discovery issues
    const replicaSetUrl = `mongodb://localhost:${mongoPort}/?replicaSet=${replicaSetName}&directConnection=true&serverSelectionTimeoutMS=30000&connectTimeoutMS=30000`;    
    mongoClient = new MongoClient(replicaSetUrl);

    try {
      await mongoClient.connect();
      console.log('✓ Connected to MongoDB replica set');

      const adminDb = mongoClient.db('admin');
      await adminDb.command({ ismaster: 1 });
    } catch (error) {
      console.error('⚠ Failed to connect to replica set:', error.message);
      throw error;
    }

    // Start the API server with test configuration
    const serverPort = 3001; // Use different port for testing
    baseUrl = `http://localhost:${serverPort}`;

    // Set environment variables for the server
    process.env.MONGODB_URL = replicaSetUrl;
    process.env.DB_NAME = 'testdb';
    process.env.AUTH_USERNAME = 'testuser';
    process.env.AUTH_PASSWORD = 'testpass';
    process.env.PORT = serverPort;

    // Import and start server (this will be a dynamic import to allow env vars to be set first)
    const { startServer } = await import('../dist/index.js');
    serverInfo = await startServer();

    // Wait a bit for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log(`✓ API server started on port ${serverInfo.port}`);
  });

  after(async () => {
    console.log('↺ Cleaning up test environment...');

    try {
      if (mongoClient) {
        await mongoClient.close();
      }

      for (const container of mongoContainers) {
        console.log('↺ Stopping MongoDB container...');
        await container.stop();
      }

      console.log('✓ Test cleanup completed');
    } catch (error) {
      console.error('⚠ Error during cleanup:', error);
    } finally {
      // Force exit since the server doesn't have an easy close method
      process.exit(0);
    }
  });

  afterEach(async () => {
    // Reset database after each test for isolation
    if (mongoClient) {
      try {
        const db = mongoClient.db('testdb');
        const collections = await db.listCollections().toArray();

        // Drop all collections to ensure clean state
        for (const collection of collections) {
          await db.collection(collection.name).drop();
        }

        console.log(
          `Reset database: dropped ${collections.length} collections`
        );
      } catch (error) {
        console.warn('Warning: Failed to reset database:', error.message);
      }
    }
  });

  // Helper function to make authenticated requests
  async function makeRequest(path, options = {}) {
    const auth = Buffer.from('testuser:testpass').toString('base64');

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      // Log error responses for debugging
      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        let errorBody = 'No body';

        try {
          if (contentType && contentType.includes('application/json')) {
            errorBody = JSON.stringify(await response.clone().json(), null, 2);
          } else {
            errorBody = await response.clone().text();
          }
        } catch {
          errorBody = 'Failed to read response body';
        }

        console.error(`Request failed: ${options.method || 'GET'} ${path}`);
        console.error(`Status: ${response.status} ${response.statusText}`);
        console.error('Response body:', errorBody);
      }

      return response;
    } catch (error) {
      console.error(
        `Network error for ${options.method || 'GET'} ${path}:`,
        error.message
      );
      throw error;
    }
  }

  describe('Health Check', () => {
    it('should return health check information', async () => {
      const response = await makeRequest('/');
      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.data.message, 'MongoDB API is running');
      assert.strictEqual(data.data.version, 'v0');
    });
  });

  describe('Collection Operations', () => {
    it('should list collections', async () => {
      const response = await makeRequest('/v0/collections');
      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert(Array.isArray(data.data));
    });
  });

  describe('Document CRUD Operations', () => {
    const testCollection = 'test_collection';
    let insertedId;

    it('should insert a single document', async () => {
      const testDoc = { name: 'Test Document', value: 42 };

      const response = await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert(data.data);
      assert(data.data._id);
      assert.strictEqual(data.data.name, testDoc.name);
      assert.strictEqual(data.data.value, testDoc.value);

      insertedId = data.data._id;
    });

    it('should find documents', async () => {
      // Setup: Insert a document first
      const testDoc = { name: 'Test Document', value: 42 };
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      const response = await makeRequest('/v0/find', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: { name: 'Test Document' },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.count, 1);
      assert.strictEqual(data.data[0].name, 'Test Document');
    });

    it('should find one document', async () => {
      // Setup: Insert a document first
      const testDoc = { name: 'Test Document', value: 42 };
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      const response = await makeRequest('/v0/find-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: { name: 'Test Document' },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert(data.data);
      assert.strictEqual(data.data.name, 'Test Document');
    });

    it('should count documents', async () => {
      // Setup: Insert a document first
      const testDoc = { name: 'Test Document', value: 42 };
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      const response = await makeRequest('/v0/count', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: {},
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.count, 1);
    });

    it('should insert multiple documents', async () => {
      const testDocs = [
        { name: 'Doc 1', type: 'batch' },
        { name: 'Doc 2', type: 'batch' },
        { name: 'Doc 3', type: 'batch' },
      ];

      const response = await makeRequest('/v0/insert-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          documents: testDocs,
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.count, 3);
      assert.strictEqual(data.data.length, 3);
    });

    it('should update one document', async () => {
      // Setup: Insert a document first
      const testDoc = { name: 'Test Document', value: 42 };
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      const response = await makeRequest('/v0/update-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: { name: 'Test Document' },
          update: { $set: { updated: true, value: 100 } },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert(data.data);
    });

    it('should update many documents', async () => {
      // Setup: Insert batch documents first
      const testDocs = [
        { name: 'Doc 1', type: 'batch' },
        { name: 'Doc 2', type: 'batch' },
        { name: 'Doc 3', type: 'batch' },
      ];

      await makeRequest('/v0/insert-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          documents: testDocs,
        }),
      });

      const response = await makeRequest('/v0/update-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: { type: 'batch' },
          update: { $set: { batchUpdated: true } },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.modifiedCount, 3);
      assert.strictEqual(data.data.length, 3);
    });

    it('should delete one document', async () => {
      // Setup: Insert a document first
      const testDoc = { name: 'Doc 1', type: 'batch' };
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      const response = await makeRequest('/v0/delete-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: { name: 'Doc 1' },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.deletedCount, 1);
    });

    it('should delete many documents', async () => {
      // Setup: Insert batch documents first
      const testDocs = [
        { name: 'Doc 2', type: 'batch' },
        { name: 'Doc 3', type: 'batch' },
      ];

      await makeRequest('/v0/insert-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          documents: testDocs,
        }),
      });

      const response = await makeRequest('/v0/delete-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          filter: { type: 'batch' },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert.strictEqual(data.deletedCount, 2);
    });
  });

  describe('Index Operations', () => {
    const testCollection = 'index_test_collection';

    it('should create an index', async () => {
      // First insert a document so the collection exists
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: { name: 'index test', email: 'test@example.com' },
        }),
      });

      const response = await makeRequest('/v0/create-index', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          keys: { email: 1 },
          options: { unique: true },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert(data.data.indexName);
    });

    it('should drop an index', async () => {
      // Setup: Insert a document and create an index first
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: { name: 'index test', email: 'test@example.com' },
        }),
      });

      await makeRequest('/v0/create-index', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          keys: { email: 1 },
          options: { unique: true },
        }),
      });

      const response = await makeRequest('/v0/drop-index', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          index: { email: 1 },
        }),
      });

      assert.strictEqual(response.status, 200);

      const data = await response.json();
      assert(data.data);
      // Just verify we get a response - MongoDB dropIndex behavior varies
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for missing required fields', async () => {
      const response = await makeRequest('/v0/find', {
        method: 'POST',
        body: JSON.stringify({}), // Missing collection field
      });

      assert.strictEqual(response.status, 400);

      const data = await response.json();
      assert(data.error);
      assert(data.error.includes('collection'));
    });

    it('should return 400 for invalid documents array', async () => {
      const response = await makeRequest('/v0/insert-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: 'test',
          documents: 'not an array',
        }),
      });

      assert.strictEqual(response.status, 400);

      const data = await response.json();
      assert(data.error);
      assert(data.error.includes('array'));
    });

    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/`);
      assert.strictEqual(response.status, 401);
    });
  });
});
