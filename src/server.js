import express from 'express';
import { startCronJobs } from './cron/index.js';

const app = express();

app.use(express.json());

startCronJobs();

app.get('/', (req, res) => {
  res.send('Server running');
});

app.listen(3000, () => {
  console.log('Server started on port 3000');
});
