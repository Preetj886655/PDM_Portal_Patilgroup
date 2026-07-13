const server = require('./mock-drive-server.js');
const { fetchDriveFile } = require('./googleDrive.js');

async function run() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  process.env.__DRIVE_TEST_BASE_URL = base;
  console.log('Mock Drive server listening on', base);

  const cases = [
    { name: 'Small file, no interstitial', id: 'SMALL_FILE_OK', expectOk: true, expectExt: '.step' },
    { name: 'Large file, confirm-token interstitial bypass', id: 'LARGE_FILE_NEEDS_CONFIRM', expectOk: true, expectExt: '.stp' },
    { name: 'Private/permission-denied file', id: 'PRIVATE_FILE', expectOk: false, expectMsgContains: 'publicly accessible' },
    { name: 'Empty file', id: 'EMPTY_FILE', expectOk: false, expectMsgContains: 'empty' },
    { name: 'No filename hint (defaults to .step)', id: 'NO_FILENAME_HINT', expectOk: true, expectExt: '.step' },
  ];

  let pass = 0, fail = 0;
  for (const c of cases) {
    const shareUrl = `https://drive.google.com/file/d/${c.id}/view?usp=drive_link`;
    try {
      const result = await fetchDriveFile(shareUrl);
      if (c.expectOk) {
        const extOk = result.extension === c.expectExt;
        const sizeOk = result.buffer.length > 0;
        console.log(`${extOk && sizeOk ? 'PASS' : 'FAIL'} - ${c.name}: extension=${result.extension} size=${result.buffer.length}`);
        extOk && sizeOk ? pass++ : fail++;
      } else {
        console.log(`FAIL - ${c.name}: expected an error but got a successful result`);
        fail++;
      }
    } catch (e) {
      if (!c.expectOk) {
        const msgOk = e.message.includes(c.expectMsgContains);
        console.log(`${msgOk ? 'PASS' : 'FAIL'} - ${c.name}: "${e.message}"`);
        msgOk ? pass++ : fail++;
      } else {
        console.log(`FAIL - ${c.name}: unexpected error: ${e.message}`);
        fail++;
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

run();
