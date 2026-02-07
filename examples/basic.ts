import { FalkorDB } from 'falkordblite';

async function main() {
  const db = await FalkorDB.open();
  const graph = db.selectGraph('basic');

  await graph.query(
    'CREATE (:Person {name:"Alice"})-[:KNOWS]->(:Person {name:"Bob"})',
  );

  const result = await graph.query(
    'MATCH (p:Person)-[:KNOWS]->(f:Person) RETURN p.name, f.name',
  );

  console.log(result.data);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
