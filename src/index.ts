import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { timeout } from 'hono/timeout';
import { type Db, MongoClient } from 'mongodb';

const app = new Hono();

type ErrorResponse = {
  error: string;
  debug?: {
    message: string;
    stack?: string;
    name: string;
    timestamp: string;
    requestId: string;
  };
};

app.onError((err, c) => {
  let status: HTTPException['status'] = 500;
  let message = 'Internal server error';
  const errorResponse: ErrorResponse = { error: message };

  if (err instanceof HTTPException) {
    status = err.status;
    message = err.message;
    errorResponse.error = message;
  }

  if (status >= 500) {
    const requestId = c.req.header('x-request-id') || 'unknown';
    console.error(`Internal server error [request id: ${requestId}]`, err);
  }

  if (process.env.DEBUG === 'true') {
    errorResponse.debug = {
      stack: err.stack,
      name: err.name,
      message: err.message,
      timestamp: new Date().toISOString(),
      requestId: c.req.header('x-request-id') || 'unknown',
    };
  }

  return c.json(errorResponse, status);
});

app.use('*', logger());

app.use(
  '*',
  timeout(10000, () => new HTTPException(408, { message: 'Request timed out' }))
);

app.use(
  '*',
  basicAuth({
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || 'password',
    realm: 'MongoDB API',
  })
);

app.use(prettyJSON());

let db: Db;
let client: MongoClient;

async function initMongoDB() {
  const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';
  const dbName = process.env.DB_NAME || 'testdb';

  try {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db(dbName);
    console.log(`Connected to MongoDB: ${mongoUrl}/${dbName}`);
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

function validateRequest(body: any, requiredFields: string[]) {
  if (!body) {
    throw new HTTPException(400, { message: 'Request body is required' });
  }

  for (const field of requiredFields) {
    if (!body[field]) {
      throw new HTTPException(400, { message: `Field '${field}' is required` });
    }
  }
}

app.get('/', async (c) => {
  await db.stats();

  return c.json({
    data: {
      message: 'MongoDB API is running',
      version: 'v0',
    },
  });
});

app.post('/v0/find', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection']);

  const { collection, filter = {}, options = {} } = body;
  const result = await db
    .collection(collection)
    .find(filter, options)
    .toArray();

  return c.json({
    data: result,
    count: result.length,
  });
});

app.post('/v0/find-one', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection']);

  const { collection, filter = {}, options = {} } = body;
  const result = await db.collection(collection).findOne(filter, options);

  return c.json({
    data: result,
  });
});

app.post('/v0/insert-one', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'document']);

  const { collection, document, options = {} } = body;
  const result = await db.collection(collection).insertOne(document, options);

  const insertedDocument = await db
    .collection(collection)
    .findOne({ _id: result.insertedId });

  return c.json({
    data: insertedDocument,
  });
});

app.post('/v0/insert-many', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'documents']);

  if (!Array.isArray(body.documents)) {
    throw new HTTPException(400, { message: 'Documents must be an array' });
  }

  const { collection, documents, options = {} } = body;
  const result = await db.collection(collection).insertMany(documents, options);

  const insertedDocuments = await db
    .collection(collection)
    .find({ _id: { $in: Object.values(result.insertedIds) } })
    .toArray();

  return c.json({
    data: insertedDocuments,
    count: result.insertedCount,
  });
});

app.post('/v0/update-one', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'filter', 'update']);

  const { collection, filter, update, options = {} } = body;

  const result = await db
    .collection(collection)
    .findOneAndUpdate(filter, update, { ...options, returnDocument: 'after' });

  return c.json({
    data: result,
  });
});

app.post('/v0/update-many', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'filter', 'update']);

  const { collection, filter, update, options = {} } = body;

  const documentsToUpdate = await db
    .collection(collection)
    .find(filter)
    .toArray();
  const idsToUpdate = documentsToUpdate.map((doc) => doc._id);

  const updateResult = await db
    .collection(collection)
    .updateMany(filter, update, options);

  const updatedDocuments = await db
    .collection(collection)
    .find({ _id: { $in: idsToUpdate } })
    .toArray();

  return c.json({
    data: updatedDocuments,
    modifiedCount: updateResult.modifiedCount,
  });
});

app.post('/v0/delete-one', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'filter']);

  const { collection, filter, options = {} } = body;
  const result = await db.collection(collection).deleteOne(filter, options);

  return c.json({
    deletedCount: result.deletedCount,
  });
});

app.post('/v0/delete-many', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'filter']);

  const { collection, filter, options = {} } = body;
  const result = await db.collection(collection).deleteMany(filter, options);

  return c.json({
    deletedCount: result.deletedCount,
  });
});

app.post('/v0/count', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection']);

  const { collection, filter = {}, options = {} } = body;
  const count = await db.collection(collection).countDocuments(filter, options);

  return c.json({
    count,
  });
});

app.get('/v0/collections', async (c) => {
  const collections = await db.listCollections().toArray();
  return c.json({
    data: collections.map((col) => col.name),
  });
});

app.post('/v0/create-index', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'keys']);

  const { collection, keys, options = {} } = body;
  const result = await db.collection(collection).createIndex(keys, options);

  return c.json({
    data: { indexName: result },
  });
});

app.post('/v0/drop-index', async (c) => {
  const body = await c.req.json();
  validateRequest(body, ['collection', 'index']);

  const { collection, index, options = {} } = body;
  const result = await db.collection(collection).dropIndex(index, options);

  return c.json({
    data: { acknowledged: result.acknowledged },
  });
});

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  if (client) {
    await client.close();
  }
  process.exit(0);
});

async function startServer() {
  await initMongoDB();

  serve(
    {
      fetch: app.fetch,
      port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000,
    },
    (info) => {
      console.log(`Server is running on :${info.port}`);
    }
  );
}

startServer().catch(console.error);
