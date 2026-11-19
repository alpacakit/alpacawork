import { startServer } from '../apps/backend/test-dist/receiver/server.js';
const app=await startServer(process.argv[2],0,
  process.env.ALPACAWORK_TEST_PUBLIC_HOST ? { publicHost: process.env.ALPACAWORK_TEST_PUBLIC_HOST } : {});
process.on('SIGTERM',()=>void app.close().then(()=>process.exit(0)));
console.log(JSON.stringify({url:app.url,connection:app.connection,generation:app.generation}));
