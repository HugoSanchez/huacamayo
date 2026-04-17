/**
 * Smoke test: verify PGLite engine initializes, can create a page, and search it.
 */
import { PGLiteEngine } from './pglite-engine.ts';

async function smoke() {
  console.log('1. Creating PGLite engine (in-memory)...');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' }); // in-memory, no path
  await engine.initSchema();
  console.log('   OK — schema initialized');

  console.log('2. Writing a page...');
  const page = await engine.putPage('test/hello-world', {
    type: 'concept',
    title: 'Hello World',
    compiled_truth: 'This is a test page about the hello world concept in programming.',
    timeline: '',
    frontmatter: {},
  });
  console.log(`   OK — page created: ${page.slug}`);

  console.log('3. Reading it back...');
  const fetched = await engine.getPage('test/hello-world');
  if (!fetched) throw new Error('Page not found after creation');
  console.log(`   OK — title: "${fetched.title}", type: ${fetched.type}`);

  console.log('4. Keyword search...');
  const results = await engine.searchKeyword('hello world');
  console.log(`   OK — ${results.length} result(s)`);

  console.log('5. Adding a link...');
  await engine.putPage('concepts/programming', {
    type: 'concept',
    title: 'Programming',
    compiled_truth: 'Programming is the art of writing code.',
    timeline: '',
    frontmatter: {},
  });
  await engine.addLink('test/hello-world', 'concepts/programming', 'related', 'related_to');
  const links = await engine.getLinks('test/hello-world');
  console.log(`   OK — ${links.length} link(s) from hello-world`);

  const backlinks = await engine.getBacklinks('concepts/programming');
  console.log(`   OK — ${backlinks.length} backlink(s) to programming`);

  console.log('6. Graph traversal...');
  const graph = await engine.traverseGraph('test/hello-world', 2);
  console.log(`   OK — ${graph.length} node(s) in graph`);

  console.log('7. Stats...');
  const stats = await engine.getStats();
  console.log(`   OK — ${stats.page_count} pages, ${stats.chunk_count} chunks`);

  await engine.disconnect();
  console.log('\nAll smoke tests passed.');
}

smoke().catch(err => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
