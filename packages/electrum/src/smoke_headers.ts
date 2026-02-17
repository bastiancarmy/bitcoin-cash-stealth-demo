import { subscribeHeaders } from './electrum.js';

const client = await subscribeHeaders('chipnet', (h) => {
  console.log('header:', h);
});

setTimeout(async () => {
  await client.disconnect();
  console.log('disconnected');
}, 5000);