import { FalkorDB } from 'falkordblite';

async function main() {
  const db = await FalkorDB.open({
    additionalConfig: { port: '6379' },
  });
  const graph = db.selectGraph('graphrag');

  await graph.query(
    'CREATE (:Document {id: 1, title: "Hello", body: "GraphRAG demo"})',
  );

  /*
    GraphRAG-SDK is currently Python-only. With the embedded server listening
    on 127.0.0.1:6379, you can connect from Python:

    pip install graphrag_sdk falkordb

    python - <<'PY'
    from falkordb import FalkorDB
    # Connect to the embedded server:
    db = FalkorDB(host="127.0.0.1", port=6379)
    graph = db.select_graph("graphrag")
    # Use the GraphRAG SDK with your graph here.
    PY
  */

  const shutdown = async () => {
    await db.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  console.log('Embedded server running on 127.0.0.1:6379.');
  console.log('Press Ctrl+C to stop.');

  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
