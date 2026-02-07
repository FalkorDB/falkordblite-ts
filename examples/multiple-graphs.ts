import { FalkorDB } from 'falkordblite';

async function main() {
  const db = await FalkorDB.open();
  const graphA = db.selectGraph('graph_a');
  const graphB = db.selectGraph('graph_b');

  await graphA.query('CREATE (:A {val:1})');
  await graphB.query('CREATE (:B {val:2})');

  const list = await db.list();
  console.log('Graphs:', list);

  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
