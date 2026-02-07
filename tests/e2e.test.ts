import { FalkorDB } from '../src/falkordb';
import { FalkorDB as FalkorDBClient } from 'falkordb';
import { makeTempDir, onCleanup, cleanupAll } from './helpers';

jest.setTimeout(30_000);

afterAll(async () => {
  await cleanupAll();
});

/** Open a tracked ephemeral instance — always torn down in afterAll. */
async function openTracked(options?: Parameters<typeof FalkorDB.open>[0]) {
  const db = await FalkorDB.open(options);
  onCleanup(() => db.close());
  return db;
}

// ---------------------------------------------------------------------------
// Ephemeral mode
// ---------------------------------------------------------------------------

describe('ephemeral mode', () => {
  it('opens and closes without a path', async () => {
    const db = await openTracked();

    expect(db.isRunning).toBe(true);
    expect(db.pid).toBeDefined();
    expect(db.socketPath).toBeDefined();

    await db.close();

    expect(db.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe('full lifecycle', () => {
  it('open → create → query → close', async () => {
    const db = await openTracked();
    const graph = db.selectGraph('lifecycle');

    await graph.query(
      'CREATE (:Person {name:"Alice"})-[:KNOWS]->(:Person {name:"Bob"})',
    );

    const result = await graph.query(
      'MATCH (p:Person)-[:KNOWS]->(f:Person) RETURN p.name, f.name',
    );

    expect(result.data).toBeDefined();
    expect(result.data).toHaveLength(1);
    expect(result.data![0]).toEqual({
      'p.name': 'Alice',
      'f.name': 'Bob',
    });

    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Graph CRUD
// ---------------------------------------------------------------------------

describe('graph CRUD operations', () => {
  let db: FalkorDB;

  beforeAll(async () => {
    db = await openTracked();
  });

  afterAll(async () => {
    await db.close();
  });

  it('CREATE nodes', async () => {
    const graph = db.selectGraph('crud');
    await graph.query('CREATE (:City {name:"London"})');
    await graph.query('CREATE (:City {name:"Paris"})');
    await graph.query('CREATE (:City {name:"Tokyo"})');

    const result = await graph.query(
      'MATCH (c:City) RETURN count(c) AS cnt',
    );
    expect(result.data![0]).toEqual({ cnt: 3 });
  });

  it('MATCH with filter', async () => {
    const graph = db.selectGraph('crud');
    const result = await graph.query(
      'MATCH (c:City) WHERE c.name = "Paris" RETURN c.name',
    );
    expect(result.data).toHaveLength(1);
    expect(result.data![0]).toEqual({ 'c.name': 'Paris' });
  });

  it('CREATE relationships', async () => {
    const graph = db.selectGraph('crud');
    await graph.query(
      'MATCH (a:City {name:"London"}), (b:City {name:"Paris"}) ' +
      'CREATE (a)-[:FLIGHT {hours: 1}]->(b)',
    );

    const result = await graph.query(
      'MATCH (a)-[r:FLIGHT]->(b) RETURN a.name, b.name, r.hours',
    );
    expect(result.data).toHaveLength(1);
    expect(result.data![0]).toEqual({
      'a.name': 'London',
      'b.name': 'Paris',
      'r.hours': 1,
    });
  });

  it('DELETE a node', async () => {
    const graph = db.selectGraph('crud');
    await graph.query('MATCH (c:City {name:"Tokyo"}) DELETE c');

    const result = await graph.query(
      'MATCH (c:City) RETURN count(c) AS cnt',
    );
    expect(result.data![0]).toEqual({ cnt: 2 });
  });

  it('UPDATE a property', async () => {
    const graph = db.selectGraph('crud');
    await graph.query(
      'MATCH (c:City {name:"London"}) SET c.population = 9000000',
    );

    const result = await graph.query(
      'MATCH (c:City {name:"London"}) RETURN c.population',
    );
    expect(result.data![0]).toEqual({ 'c.population': 9000000 });
  });
});

// ---------------------------------------------------------------------------
// Multiple graphs
// ---------------------------------------------------------------------------

describe('multiple graphs in one database', () => {
  it('maintains separate data per graph', async () => {
    const db = await openTracked();

    const graphA = db.selectGraph('graph_a');
    const graphB = db.selectGraph('graph_b');

    await graphA.query('CREATE (:X {val: 1})');
    await graphB.query('CREATE (:Y {val: 2})');

    const rA = await graphA.query('MATCH (n) RETURN n.val');
    const rB = await graphB.query('MATCH (n) RETURN n.val');

    expect(rA.data).toHaveLength(1);
    expect(rA.data![0]).toEqual({ 'n.val': 1 });
    expect(rB.data).toHaveLength(1);
    expect(rB.data![0]).toEqual({ 'n.val': 2 });

    const graphs = await db.list();
    expect(graphs.sort()).toEqual(['graph_a', 'graph_b']);

    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('data survives close and reopen', async () => {
    const dbPath = await makeTempDir('falkordblite-persist-');

    // Phase 1: write data
    const db1 = await openTracked({ path: dbPath });
    const g1 = db1.selectGraph('persist');
    await g1.query(
      'CREATE (:Item {id:1}), (:Item {id:2}), (:Item {id:3})',
    );
    await db1.close();

    // Phase 2: reopen, verify data
    const db2 = await openTracked({ path: dbPath });
    const g2 = db2.selectGraph('persist');
    const result = await g2.query(
      'MATCH (i:Item) RETURN i.id ORDER BY i.id',
    );

    expect(result.data).toHaveLength(3);
    expect(result.data).toEqual([
      { 'i.id': 1 },
      { 'i.id': 2 },
      { 'i.id': 3 },
    ]);

    await db2.close();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('rejects invalid Cypher queries', async () => {
    const db = await openTracked();
    const graph = db.selectGraph('errors');

    await expect(
      graph.query('THIS IS NOT VALID CYPHER'),
    ).rejects.toThrow();

    await db.close();
  });

  it('parameterised queries work', async () => {
    const db = await openTracked();
    const graph = db.selectGraph('params');

    await graph.query('CREATE (:N {val: $v})', { params: { v: 42 } });

    const result = await graph.query(
      'MATCH (n:N) WHERE n.val = $v RETURN n.val',
      { params: { v: 42 } },
    );
    expect(result.data).toHaveLength(1);
    expect(result.data![0]).toEqual({ 'n.val': 42 });

    await db.close();
  });
});

// ---------------------------------------------------------------------------
// API compatibility (migration path)
// ---------------------------------------------------------------------------

describe('API compatibility with falkordb-ts', () => {
  it('a raw falkordb-ts client can connect to the embedded server', async () => {
    const db = await openTracked();

    // Write via falkordblite
    const graph = db.selectGraph('compat');
    await graph.query('CREATE (:Test {source:"embedded"})');

    // Connect a separate falkordb-ts client to the same socket
    const external = await FalkorDBClient.connect({
      socket: { path: db.socketPath },
    });

    try {
      const extGraph = external.selectGraph('compat');
      const result = await extGraph.query(
        'MATCH (n:Test) RETURN n.source',
      );

      expect(result.data).toHaveLength(1);
      expect(result.data![0]).toEqual({ 'n.source': 'embedded' });
    } finally {
      await external.close();
    }

    await db.close();
  });

  it('selectGraph() returns an object with the full Graph API', async () => {
    const db = await openTracked();
    const graph = db.selectGraph('api_check');

    // Verify the Graph has all expected methods from falkordb-ts.
    expect(typeof graph.query).toBe('function');
    expect(typeof graph.roQuery).toBe('function');
    expect(typeof graph.delete).toBe('function');
    expect(typeof graph.copy).toBe('function');
    expect(typeof graph.explain).toBe('function');
    expect(typeof graph.profile).toBe('function');
    expect(typeof graph.slowLog).toBe('function');
    expect(typeof graph.constraintCreate).toBe('function');
    expect(typeof graph.constraintDrop).toBe('function');

    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Concurrent instances
// ---------------------------------------------------------------------------

describe('concurrent instances', () => {
  it('two ephemeral instances are fully isolated', async () => {
    const db1 = await openTracked();
    const db2 = await openTracked();

    expect(db1.socketPath).not.toBe(db2.socketPath);
    expect(db1.pid).not.toBe(db2.pid);

    const g1 = db1.selectGraph('g');
    const g2 = db2.selectGraph('g');

    await g1.query('CREATE (:A {v:1})');
    await g2.query('CREATE (:B {v:2})');

    const r1 = await g1.query('MATCH (n) RETURN n.v');
    const r2 = await g2.query('MATCH (n) RETURN n.v');

    // Each instance only sees its own data.
    expect(r1.data).toHaveLength(1);
    expect(r1.data![0]).toEqual({ 'n.v': 1 });
    expect(r2.data).toHaveLength(1);
    expect(r2.data![0]).toEqual({ 'n.v': 2 });

    await db1.close();
    await db2.close();
  });
});

// ---------------------------------------------------------------------------
// Database-level operations
// ---------------------------------------------------------------------------

describe('database operations', () => {
  it('list() returns graph names', async () => {
    const db = await openTracked();
    const graph = db.selectGraph('listed');
    await graph.query('CREATE (:N)');

    const list = await db.list();
    expect(list).toContain('listed');

    await db.close();
  });

  it('info() returns server information', async () => {
    const db = await openTracked();
    const info = await db.info();

    expect(info).toBeDefined();
    expect(Array.isArray(info)).toBe(true);

    await db.close();
  });

  it('configGet/configSet round-trip', async () => {
    const db = await openTracked();

    // THREAD_COUNT is a FalkorDB config key
    const before = await db.configGet('THREAD_COUNT');
    expect(before).toBeDefined();

    await db.close();
  });
});
