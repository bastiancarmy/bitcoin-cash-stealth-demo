// packages/electrum/src/smoke_chipnet.ts
import { connectElectrum } from './electrum.js';

async function main() {
  const client = await connectElectrum('chipnet');

  try {
    // Most Electrum servers return the current tip header object here,
    // and also begin streaming notifications (we just smoke-test the call).
    const tip = await client.request('blockchain.headers.subscribe');
    // eslint-disable-next-line no-console
    console.log('headers.subscribe ok:', tip);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('smoke failed:', err);
  process.exitCode = 1;
});