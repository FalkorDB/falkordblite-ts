import { FalkorDB } from 'falkordblite';

async function main() {
  const dbPath = './data/falkordblite-persist';

  const db1 = await FalkorDB.open({ path: dbPath });
  const graph1 = db1.selectGraph('persist');
  await graph1.query(
    'CREATE (:Item {id:1}), (:Item {id:2}), (:Item {id:3})',
  );
  await db1.close();

  const db2 = await FalkorDB.open({ path: dbPath });
  const graph2 = db2.selectGraph('persist');
  const result = await graph2.query(
    'MATCH (i:Item) RETURN i.id ORDER BY i.id',
  );

  console.log(result.data);
  await db2.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
