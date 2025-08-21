import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { prettyJSON } from 'hono/pretty-json';
import { timeout } from 'hono/timeout';
import { type Db, MongoClient } from 'mongodb';
import { z } from 'zod';

const app = new Hono();

let db: Db;
let client: MongoClient;

type LogLevel = 'info' | 'error' | 'warn' | 'debug';

function structuredLog(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

function errorLog(
  level: LogLevel,
  message: string,
  error: unknown,
  data?: Record<string, unknown>,
) {
  const errorData =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : error;

  structuredLog(level, message, { error: errorData, ...data });
}

function requestLog(
  c: Context,
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
) {
  const requestId = c.req.header('x-request-id') || 'unknown';
  structuredLog(level, message, { requestId, ...data });
}

type ErrorResponse = {
  error: string;
  debug?: {
    message: string;
    stack: string | undefined;
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
    requestLog(c, 'error', 'Internal server error', {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    });
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

app.use('*', async (c, next) => {
  const { method, url } = c.req;
  const path = url.slice(url.indexOf('/', 8));

  requestLog(c, 'info', 'incoming request', { method, path });

  const start = Date.now();
  await next();

  const delta = Date.now() - start;
  requestLog(c, 'info', 'outgoing response', {
    method,
    path,
    status: c.res.status,
    duration: `${delta}ms`,
  });
});

app.use(
  '*',
  timeout(
    10000,
    () => new HTTPException(408, { message: 'Request timed out' }),
  ),
);

app.use('/openapi.yml', serveStatic({ path: '../openapi.yml' }));

app.use(
  '*',
  basicAuth({
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || 'password',
    realm: 'MongoDB API',
  }),
);

app.use(prettyJSON());

async function initMongoDB() {
  const baseMongoUrl = process.env.MONGODB_URL;
  if (!baseMongoUrl) {
    throw new Error('MONGODB_URL is not set');
  }

  const mongoUrl = new URL(baseMongoUrl);
  // Only set secondaryPreferred for non-transaction operations
  // For transactions, we'll use primary read preference by default
  if (!mongoUrl.searchParams.has('readPreference')) {
    mongoUrl.searchParams.set('readPreference', 'secondaryPreferred');
  }

  const dbName = process.env.DB_NAME;
  if (!dbName) {
    throw new Error('DB_NAME is not set');
  }

  try {
    client = new MongoClient(mongoUrl.toString());
    await client.connect();
    db = client.db(dbName);
    structuredLog('info', 'Connected to MongoDB', {
      url: mongoUrl.toString(),
      database: dbName,
    });
  } catch (error) {
    errorLog('error', 'Failed to connect to MongoDB', error, {
      url: mongoUrl.toString(),
      database: dbName,
    });
    process.exit(1);
  }
}

function validateWithZod<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new HTTPException(400, { message: `Validation error: ${errors}` });
  }
  return result.data;
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

const FindSchema = z.object({
  collection: z.string(),
  filter: z.any().default({}),
  options: z.any().default({}),
});

app.post('/v0/find', async (c) => {
  const body = await c.req.json();
  const { collection, filter, options } = validateWithZod(FindSchema, body);
  const result = await db
    .collection(collection)
    .find(filter, options)
    .toArray();

  return c.json({
    data: result,
    count: result.length,
  });
});

const FindOneSchema = z.object({
  collection: z.string(),
  filter: z.any().default({}),
  options: z.any().default({}),
});

app.post('/v0/find-one', async (c) => {
  const body = await c.req.json();
  const { collection, filter, options } = validateWithZod(FindOneSchema, body);
  const result = await db.collection(collection).findOne(filter, options);

  return c.json({
    data: result,
  });
});

const InsertOneSchema = z.object({
  collection: z.string(),
  document: z.any(),
  options: z.any().default({}),
});

app.post('/v0/insert-one', async (c) => {
  const body = await c.req.json();
  const { collection, document, options } = validateWithZod(
    InsertOneSchema,
    body,
  );
  const result = await db.collection(collection).insertOne(document, options);

  const insertedDocument = await db
    .collection(collection)
    .findOne({ _id: result.insertedId });

  return c.json({
    data: insertedDocument,
  });
});

const InsertManySchema = z.object({
  collection: z.string(),
  documents: z.array(z.any()),
  options: z.any().default({}),
});

app.post('/v0/insert-many', async (c) => {
  const body = await c.req.json();
  const { collection, documents, options } = validateWithZod(
    InsertManySchema,
    body,
  );
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

const UpdateOneSchema = z.object({
  collection: z.string(),
  filter: z.any(),
  update: z.any(),
  options: z.any().default({}),
});

app.post('/v0/update-one', async (c) => {
  const body = await c.req.json();
  const { collection, filter, update, options } = validateWithZod(
    UpdateOneSchema,
    body,
  );

  const result = await db
    .collection(collection)
    .findOneAndUpdate(filter, update, { ...options, returnDocument: 'after' });

  return c.json({
    data: result,
  });
});

const UpdateManySchema = z.object({
  collection: z.string(),
  filter: z.any(),
  update: z.any(),
  options: z.any().default({}),
});

app.post('/v0/update-many', async (c) => {
  const body = await c.req.json();
  const { collection, filter, update, options } = validateWithZod(
    UpdateManySchema,
    body,
  );

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

const DeleteOneSchema = z.object({
  collection: z.string(),
  filter: z.any(),
  options: z.any().default({}),
});

app.post('/v0/delete-one', async (c) => {
  const body = await c.req.json();
  const { collection, filter, options } = validateWithZod(
    DeleteOneSchema,
    body,
  );
  const result = await db.collection(collection).deleteOne(filter, options);

  return c.json({
    deletedCount: result.deletedCount,
  });
});

const DeleteManySchema = z.object({
  collection: z.string(),
  filter: z.any(),
  options: z.any().default({}),
});

app.post('/v0/delete-many', async (c) => {
  const body = await c.req.json();
  const { collection, filter, options } = validateWithZod(
    DeleteManySchema,
    body,
  );
  const result = await db.collection(collection).deleteMany(filter, options);

  return c.json({
    deletedCount: result.deletedCount,
  });
});

const CountSchema = z.object({
  collection: z.string(),
  filter: z.any().default({}),
  options: z.any().default({}),
});

app.post('/v0/count', async (c) => {
  const body = await c.req.json();
  const { collection, filter, options } = validateWithZod(CountSchema, body);
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

const CreateIndexSchema = z.object({
  collection: z.string(),
  keys: z.any(),
  options: z.any().default({}),
});

app.post('/v0/create-index', async (c) => {
  const body = await c.req.json();
  const { collection, keys, options } = validateWithZod(
    CreateIndexSchema,
    body,
  );
  const result = await db.collection(collection).createIndex(keys, options);

  return c.json({
    data: { indexName: result },
  });
});

const DropIndexSchema = z.object({
  collection: z.string(),
  index: z.union([z.string(), z.any()]),
  options: z.any().default({}),
});

app.post('/v0/drop-index', async (c) => {
  const body = await c.req.json();
  const { collection, index, options } = validateWithZod(DropIndexSchema, body);
  const result = await db.collection(collection).dropIndex(index, options);

  return c.json({
    data: { acknowledged: result.acknowledged },
  });
});

const TransactionOperationSchema = z.object({
  type: z.enum(['findOneAndUpdate', 'insertOne', 'deleteOne']),
  collection: z.string(),
  filter: z.any().optional(),
  document: z.any().optional(),
  update: z.any().optional(),
  options: z.any().default({}),
});

const TransactionSchema = z.object({
  operations: z.array(TransactionOperationSchema),
  transactionOptions: z.any().default({}),
});

app.post('/v0/transaction', async (c) => {
  const body = await c.req.json();
  const { operations, transactionOptions } = validateWithZod(
    TransactionSchema,
    body,
  );

  if (operations.length === 0) {
    throw new HTTPException(400, {
      message: 'At least one operation is required',
    });
  }

  for (const [index, operation] of operations.entries()) {
    switch (operation.type) {
      case 'findOneAndUpdate':
        if (!operation.filter || !operation.update) {
          throw new HTTPException(400, {
            message: `Operation ${index}: findOneAndUpdate requires filter and update fields`,
          });
        }
        break;
      case 'insertOne':
        if (!operation.document) {
          throw new HTTPException(400, {
            message: `Operation ${index}: insertOne requires document field`,
          });
        }
        break;
      case 'deleteOne':
        if (!operation.filter) {
          throw new HTTPException(400, {
            message: `Operation ${index}: deleteOne requires filter field`,
          });
        }
        break;
    }
  }

  const results = await client.withSession(async (session) =>
    session.withTransaction(
      async (session) => {
        const operationResults = [];

        for (const operation of operations) {
          const collection = db.collection(operation.collection);

          switch (operation.type) {
            case 'findOneAndUpdate': {
              const result = await collection.findOneAndUpdate(
                operation.filter,
                operation.update,
                {
                  ...operation.options,
                  session,
                  returnDocument: 'after',
                },
              );
              operationResults.push({
                type: 'findOneAndUpdate',
                collection: operation.collection,
                data: result,
              });
              break;
            }

            case 'insertOne': {
              const insertResult = await collection.insertOne(
                operation.document,
                { ...operation.options, session },
              );

              const insertedDocument = await collection.findOne(
                { _id: insertResult.insertedId },
                { session },
              );

              operationResults.push({
                type: 'insertOne',
                collection: operation.collection,
                data: insertedDocument,
                insertedId: insertResult.insertedId,
              });
              break;
            }

            case 'deleteOne': {
              const deleteResult = await collection.deleteOne(
                operation.filter,
                {
                  ...operation.options,
                  session,
                },
              );

              operationResults.push({
                type: 'deleteOne',
                collection: operation.collection,
                deletedCount: deleteResult.deletedCount,
              });
              break;
            }
          }
        }

        return operationResults;
      },
      {
        readPreference: 'primary',
        ...transactionOptions,
      },
    ),
  );

  requestLog(c, 'info', 'Transaction completed successfully', {
    operationCount: operations.length,
    resultsCount: results.length,
  });

  return c.json({
    data: results,
    operationCount: operations.length,
  });
});

process.on('SIGINT', async () => {
  structuredLog('info', 'Shutting down gracefully');
  if (client) {
    await client.close();
  }
  process.exit(0);
});

export async function startServer() {
  await initMongoDB();

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

  return new Promise<{ port: number }>((resolve) => {
    serve(
      {
        fetch: app.fetch,
        port,
      },
      (info) => {
        structuredLog('info', 'Server started', { port: info.port });
        resolve(info);
      },
    );
  });
}

// If this file is run directly (not imported), start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    errorLog('error', 'Failed to start server', error);
  });
}
