import { FalkorDB } from 'falkordblite';

async function main() {
  const db = await FalkorDB.open();
  const graph = db.selectGraph('migration');

  await graph.query('CREATE (:Demo {source:"embedded"})');
  const result = await graph.query('MATCH (n:Demo) RETURN n.source');
  console.log(result.data);

  await db.close();

  // Migration to a remote FalkorDB server:
  // import { FalkorDB } from 'falkordb';
  // const db = await FalkorDB.connect({
  //   socket: { host: '127.0.0.1', port: 6379 },
  // });
  // const graph = db.selectGraph('migration');
  // await graph.query('MATCH (n:Demo) RETURN n.source');
  // await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
