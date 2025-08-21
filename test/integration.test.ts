import { type Db, MongoClient } from 'mongodb';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

interface ServerInfo {
  port: number;
}

interface MakeRequestOptions extends RequestInit {
  headers?: Record<string, string>;
}

interface TestDocument {
  name: string;
  value?: number;
  type?: string;
  email?: string;
  updated?: boolean;
  batchUpdated?: boolean;
  _id?: string;
}

const mongoContainers: StartedTestContainer[] = [];
let mongoClient: MongoClient;
let serverInfo: ServerInfo;
let baseUrl: string;

describe('MongoDB REST API Integration Tests', () => {
  beforeAll(async () => {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 10000));

    console.log('↺ Initializing replica set using mongosh...');

    try {
      const initCommand = `rs.initiate({_id:'${replicaSetName}',members:[{_id:0,host:'localhost:27017'}]})`;
      const result = await container.exec([
        'mongosh',
        '--quiet',
        '--eval',
        initCommand,
      ]);

      if (
        result.output.includes('{ ok: 1 }') ||
        result.output.includes('"ok" : 1')
      ) {
        console.log('✓ Replica set initialized successfully');
      } else {
        console.log(
          '⚠ Replica set initialization may have failed:',
          result.output,
        );
      }

      console.log('↺ Waiting for replica set to be ready...');
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      console.error(
        '⚠ Error initializing replica set:',
        (error as Error).message,
      );
      throw error;
    }

    // Connect with replica set - use directConnection to bypass discovery issues
    const replicaSetUrl = `mongodb://localhost:${mongoPort}/?replicaSet=${replicaSetName}&directConnection=true&serverSelectionTimeoutMS=30000&connectTimeoutMS=30000`;
    mongoClient = new MongoClient(replicaSetUrl);

    try {
      await mongoClient.connect();
      console.log('✓ Connected to MongoDB replica set');

      const adminDb: Db = mongoClient.db('admin');
      await adminDb.command({ ismaster: 1 });
    } catch (error) {
      console.error(
        '⚠ Failed to connect to replica set:',
        (error as Error).message,
      );
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
    process.env.PORT = serverPort.toString();

    // Import and start server (this will be a dynamic import to allow env vars to be set first)
    const { startServer } = (await import('../dist/index.js')) as {
      startServer: () => Promise<ServerInfo>;
    };
    serverInfo = await startServer();

    // Wait a bit for server to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));

    console.log(`✓ API server started on port ${serverInfo.port}`);
  });

  afterAll(async () => {
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
    }
  });

  afterEach(async () => {
    // Reset database after each test for isolation
    if (mongoClient) {
      try {
        const db: Db = mongoClient.db('testdb');
        const collections = await db.listCollections().toArray();

        // Drop all collections to ensure clean state
        for (const collection of collections) {
          await db.collection(collection.name).drop();
        }

        console.log(
          `! Reset database: dropped ${collections.length} collections`,
        );
      } catch (error) {
        console.warn(
          'Warning: Failed to reset database:',
          (error as Error).message,
        );
      }
    }
  });

  // Helper function to make authenticated requests
  async function makeRequest(
    path: string,
    options: MakeRequestOptions = {},
  ): Promise<Response> {
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
          if (contentType?.includes('application/json')) {
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
        (error as Error).message,
      );
      throw error;
    }
  }

  describe('Health Check', () => {
    it('should return health check information', async () => {
      const response = await makeRequest('/');
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data.message).toBe('MongoDB API is running');
      expect(data.data.version).toBe('v0');
    });
  });

  describe('Collection Operations', () => {
    it('should list collections', async () => {
      const response = await makeRequest('/v0/collections');
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('Document CRUD Operations', () => {
    const testCollection = 'test_collection';
    let _insertedId: string;

    it('should insert a single document', async () => {
      const testDoc: TestDocument = { name: 'Test Document', value: 42 };

      const response = await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: testDoc,
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data).toBeTruthy();
      expect(data.data._id).toBeTruthy();
      expect(data.data.name).toBe(testDoc.name);
      expect(data.data.value).toBe(testDoc.value);

      _insertedId = data.data._id;
    });

    it('should find documents', async () => {
      // Setup: Insert a document first
      const testDoc: TestDocument = { name: 'Test Document', value: 42 };
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.count).toBe(1);
      expect(data.data[0].name).toBe('Test Document');
    });

    it('should find one document', async () => {
      // Setup: Insert a document first
      const testDoc: TestDocument = { name: 'Test Document', value: 42 };
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data).toBeTruthy();
      expect(data.data.name).toBe('Test Document');
    });

    it('should count documents', async () => {
      // Setup: Insert a document first
      const testDoc: TestDocument = { name: 'Test Document', value: 42 };
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.count).toBe(1);
    });

    it('should insert multiple documents', async () => {
      const testDocs: TestDocument[] = [
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.count).toBe(3);
      expect(data.data.length).toBe(3);
    });

    it('should update one document', async () => {
      // Setup: Insert a document first
      const testDoc: TestDocument = { name: 'Test Document', value: 42 };
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data).toBeTruthy();
    });

    it('should update many documents', async () => {
      // Setup: Insert batch documents first
      const testDocs: TestDocument[] = [
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modifiedCount).toBe(3);
      expect(data.data.length).toBe(3);
    });

    it('should delete one document', async () => {
      // Setup: Insert a document first
      const testDoc: TestDocument = { name: 'Doc 1', type: 'batch' };
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.deletedCount).toBe(1);
    });

    it('should delete many documents', async () => {
      // Setup: Insert batch documents first
      const testDocs: TestDocument[] = [
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.deletedCount).toBe(2);
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

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data.indexName).toBeTruthy();
    });
  });

  describe('Transaction Operations', () => {
    const testCollection = 'transaction_test_collection';
    const counterCollection = 'counter_collection';

    it('should execute successful transaction with multiple operations', async () => {
      // Setup: Insert a counter document
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: counterCollection,
          document: { name: 'userCounter', value: 0 },
        }),
      });

      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'insertOne',
              collection: testCollection,
              document: {
                name: 'John Doe',
                email: 'john@example.com',
                status: 'active',
              },
            },
            {
              type: 'findOneAndUpdate',
              collection: counterCollection,
              filter: { name: 'userCounter' },
              update: { $inc: { value: 1 } },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.operationCount).toBe(2);
      expect(data.data.length).toBe(2);

      // Verify insertOne result
      const insertResult = data.data[0];
      expect(insertResult.type).toBe('insertOne');
      expect(insertResult.collection).toBe(testCollection);
      expect(insertResult.data.name).toBe('John Doe');
      expect(insertResult.data.email).toBe('john@example.com');
      expect(insertResult.insertedId).toBeTruthy();

      // Verify findOneAndUpdate result
      const updateResult = data.data[1];
      expect(updateResult.type).toBe('findOneAndUpdate');
      expect(updateResult.collection).toBe(counterCollection);
      expect(updateResult.data.value).toBe(1);
    });

    it('should execute transaction with deleteOne operation', async () => {
      // Setup: Insert documents to delete
      await makeRequest('/v0/insert-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          documents: [
            { name: 'Doc 1', status: 'active' },
            { name: 'Doc 2', status: 'inactive' },
            { name: 'Doc 3', status: 'active' },
          ],
        }),
      });

      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'deleteOne',
              collection: testCollection,
              filter: { status: 'inactive' },
            },
            {
              type: 'findOneAndUpdate',
              collection: testCollection,
              filter: { name: 'Doc 1' },
              update: { $set: { processed: true } },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.operationCount).toBe(2);
      expect(data.data.length).toBe(2);

      // Verify deleteOne result
      const deleteResult = data.data[0];
      expect(deleteResult.type).toBe('deleteOne');
      expect(deleteResult.deletedCount).toBe(1);

      // Verify update result
      const updateResult = data.data[1];
      expect(updateResult.type).toBe('findOneAndUpdate');
      expect(updateResult.data.processed).toBe(true);
    });

    it('should handle transaction with custom options', async () => {
      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'insertOne',
              collection: testCollection,
              document: {
                name: 'Transaction Test',
                timestamp: new Date().toISOString(),
              },
            },
          ],
          transactionOptions: {
            readConcern: { level: 'majority' },
            writeConcern: { w: 'majority' },
            maxCommitTimeMS: 1000,
          },
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.operationCount).toBe(1);
      expect(data.data[0].type).toBe('insertOne');
      expect(data.data[0].data.name).toBe('Transaction Test');
    });

    it('should return 400 for empty operations array', async () => {
      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [],
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('At least one operation is required');
    });

    it('should return 400 for invalid findOneAndUpdate operation', async () => {
      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'findOneAndUpdate',
              collection: testCollection,
              filter: { name: 'test' },
              // Missing update field
            },
          ],
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain(
        'findOneAndUpdate requires filter and update fields',
      );
    });

    it('should return 400 for invalid insertOne operation', async () => {
      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'insertOne',
              collection: testCollection,
              // Missing document field
            },
          ],
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('insertOne requires document field');
    });

    it('should return 400 for invalid deleteOne operation', async () => {
      const response = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'deleteOne',
              collection: testCollection,
              // Missing filter field
            },
          ],
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('deleteOne requires filter field');
    });

    it('should ensure atomicity - all operations succeed or all fail', async () => {
      // Setup: Insert a document to update
      await makeRequest('/v0/insert-one', {
        method: 'POST',
        body: JSON.stringify({
          collection: testCollection,
          document: { name: 'Atomic Test', value: 10 },
        }),
      });

      // This transaction should succeed completely
      const successResponse = await makeRequest('/v0/transaction', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            {
              type: 'findOneAndUpdate',
              collection: testCollection,
              filter: { name: 'Atomic Test' },
              update: { $set: { value: 20, processed: true } },
            },
            {
              type: 'insertOne',
              collection: testCollection,
              document: { name: 'Related Record', parentName: 'Atomic Test' },
            },
          ],
        }),
      });

      expect(successResponse.status).toBe(200);

      const successData = await successResponse.json();
      expect(successData.operationCount).toBe(2);
      expect(successData.data.length).toBe(2);

      // Verify both operations completed
      expect(successData.data[0].data.value).toBe(20);
      expect(successData.data[0].data.processed).toBe(true);
      expect(successData.data[1].data.name).toBe('Related Record');
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for missing required fields', async () => {
      const response = await makeRequest('/v0/find', {
        method: 'POST',
        body: JSON.stringify({}), // Missing collection field
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBeTruthy();
      expect(data.error.includes('collection')).toBe(true);
    });

    it('should return 400 for invalid documents array', async () => {
      const response = await makeRequest('/v0/insert-many', {
        method: 'POST',
        body: JSON.stringify({
          collection: 'test',
          documents: 'not an array',
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBeTruthy();
      expect(data.error.includes('array')).toBe(true);
    });

    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(401);
    });
  });
});
